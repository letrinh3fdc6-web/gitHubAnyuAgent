import type { FetchFunction } from "@earendil-works/pi-ai";
import {
	ANYU_PROVIDER_ID,
	type AnyuApi,
	type AnyuAuthTokens,
	type AnyuCatalog,
	type AnyuLoginResponse,
	type AnyuModelMetadata,
	DEFAULT_ANYU_BASE_URL,
} from "./types.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
type JsonRecord = Record<string, unknown>;

export class AnyuClientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnyuClientError";
	}
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
function normalizeBaseUrl(baseUrl: string): string {
	const normalized = baseUrl.trim().replace(/\/+$/u, "");
	if (!/^https?:\/\//iu.test(normalized)) throw new Error("Anyu base URL must use HTTP or HTTPS.");
	return normalized;
}
function unwrapEnvelope(payload: unknown): unknown {
	if (!isRecord(payload) || typeof payload.code !== "number") return payload;
	if (payload.code !== 0) throw new AnyuClientError("Anyu rejected this request.");
	return "data" in payload ? payload.data : payload;
}
function modelApi(id: string, source: unknown): AnyuApi {
	if (
		source === "openai-completions" ||
		source === "openai-responses" ||
		source === "anthropic-messages" ||
		source === "google-generative-ai"
	)
		return source;
	const lower = id.toLowerCase();
	if (lower.startsWith("gemini-")) return "google-generative-ai";
	if (lower.startsWith("claude-")) return "anthropic-messages";
	return "openai-responses";
}
function parseInput(value: unknown): ("text" | "image")[] {
	if (!Array.isArray(value)) return ["text"];
	const values = value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
	return values.some((item) => item.includes("image") || item.includes("vision")) ? ["text", "image"] : ["text"];
}
function normalizeModelId(id: string): string {
	return id.startsWith("models/") ? id.slice("models/".length) : id;
}
function parseModel(value: unknown, baseUrl: string): AnyuModelMetadata | undefined {
	if (!isRecord(value)) return undefined;
	const rawId = stringValue(value.id) ?? stringValue(value.name) ?? stringValue(value.model);
	if (!rawId) return undefined;
	const id = normalizeModelId(rawId);
	const api = modelApi(id, value.api ?? value.protocol ?? value.protocol_type);
	const costValue = isRecord(value.cost) ? value.cost : undefined;
	return {
		id,
		name: stringValue(value.display_name) ?? stringValue(value.displayName) ?? stringValue(value.name) ?? id,
		displayName: stringValue(value.display_name) ?? stringValue(value.displayName),
		contextWindow: numberValue(value.context_window) ?? numberValue(value.contextWindow),
		maxTokens: numberValue(value.max_tokens) ?? numberValue(value.maxTokens),
		input: parseInput(value.input_modalities ?? value.input),
		reasoning: typeof value.reasoning === "boolean" ? value.reasoning : undefined,
		api,
		// The catalog is metadata only: never allow it to redirect inference to an arbitrary host.
		baseUrl: api === "google-generative-ai" ? `${baseUrl}/v1beta` : `${baseUrl}/v1`,
		...(costValue
			? {
					cost: {
						input: numberValue(costValue.input) ?? 0,
						output: numberValue(costValue.output) ?? 0,
						cacheRead: numberValue(costValue.cache_read) ?? numberValue(costValue.cacheRead) ?? 0,
						cacheWrite: numberValue(costValue.cache_write) ?? numberValue(costValue.cacheWrite) ?? 0,
					},
				}
			: {}),
		...(isRecord(value.compat) ? { compat: value.compat } : {}),
	};
}

export function parseAnyuCatalog(payload: unknown, baseUrl: string): AnyuCatalog {
	const unwrapped = unwrapEnvelope(payload);
	const record = isRecord(unwrapped) ? unwrapped : undefined;
	const entries = Array.isArray(unwrapped)
		? unwrapped
		: record && Array.isArray(record.models)
			? record.models
			: record && Array.isArray(record.data)
				? record.data
				: [];
	return {
		models: entries
			.map((entry) => parseModel(entry, baseUrl))
			.filter((model): model is AnyuModelMetadata => model !== undefined),
		...(record && (numberValue(record.version) !== undefined || stringValue(record.version))
			? { version: numberValue(record.version) ?? stringValue(record.version) }
			: {}),
		...(record && stringValue(record.expires_at) ? { expiresAt: stringValue(record.expires_at) } : {}),
	};
}

export function toPiModelConfig(model: AnyuModelMetadata) {
	return {
		id: model.id,
		name: model.name ?? model.displayName ?? model.id,
		api: model.api ?? "openai-responses",
		baseUrl: model.baseUrl ?? `${DEFAULT_ANYU_BASE_URL}/v1`,
		reasoning: model.reasoning ?? /(?:gpt-|o[1-9]|claude-|gemini-|reasoner)/iu.test(model.id),
		input: model.input ?? ["text"],
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens && model.maxTokens > 0 ? model.maxTokens : DEFAULT_MAX_TOKENS,
		...(model.compat ? { compat: model.compat } : {}),
	};
}

export class AnyuClient {
	readonly baseUrl: string;
	private readonly fetch: FetchFunction;
	constructor(options: { baseUrl?: string; fetch?: FetchFunction } = {}) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_ANYU_BASE_URL);
		this.fetch = options.fetch ?? globalThis.fetch;
	}
	async login(email: string, password: string, signal: AbortSignal): Promise<AnyuLoginResponse> {
		const payload = await this.request(
			"/api/v1/auth/login",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password, turnstile_token: "" }),
			},
			signal,
		);
		if (!isRecord(payload)) throw new AnyuClientError("Anyu returned an invalid login response.");
		if (payload.requires_2fa === true) {
			const tempToken = stringValue(payload.temp_token);
			if (!tempToken) throw new AnyuClientError("Anyu returned an incomplete two-factor login response.");
			return {
				type: "two_factor",
				tempToken,
				...(stringValue(payload.user_email_masked) ? { maskedEmail: stringValue(payload.user_email_masked) } : {}),
			};
		}
		return { type: "authenticated", tokens: this.parseTokens(payload) };
	}
	async login2FA(tempToken: string, code: string, signal: AbortSignal): Promise<AnyuAuthTokens> {
		const payload = await this.request(
			"/api/v1/auth/login/2fa",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ temp_token: tempToken, totp_code: code }),
			},
			signal,
		);
		if (!isRecord(payload)) throw new AnyuClientError("Anyu returned an invalid two-factor login response.");
		return this.parseTokens(payload);
	}
	async refresh(refreshToken: string, signal: AbortSignal): Promise<AnyuAuthTokens> {
		const payload = await this.request(
			"/api/v1/auth/refresh",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: refreshToken }),
			},
			signal,
		);
		if (!isRecord(payload)) throw new AnyuClientError("Anyu returned an invalid refresh response.");
		return this.parseTokens(payload);
	}
	async logout(refreshToken: string, signal: AbortSignal): Promise<void> {
		await this.request(
			"/api/v1/auth/logout",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refresh_token: refreshToken }),
			},
			signal,
		);
	}
	async catalog(accessToken: string, signal: AbortSignal): Promise<AnyuCatalog> {
		const payload = await this.request(
			"/api/v1/integrations/pi/catalog",
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			signal,
		);
		return parseAnyuCatalog(payload, this.baseUrl);
	}
	private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetch(`${this.baseUrl}${path}`, { ...init, signal });
		} catch {
			throw new AnyuClientError("Unable to reach Anyu.");
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new AnyuClientError("Anyu returned an invalid response.");
		}
		if (!response.ok) throw new AnyuClientError(`Anyu request failed (HTTP ${response.status}).`);
		return unwrapEnvelope(payload);
	}
	private parseTokens(payload: JsonRecord): AnyuAuthTokens {
		const accessToken = stringValue(payload.access_token);
		const refreshToken = stringValue(payload.refresh_token);
		const expiresIn = numberValue(payload.expires_in);
		if (!accessToken || !refreshToken || !expiresIn || expiresIn <= 0)
			throw new AnyuClientError("Anyu returned incomplete session credentials.");
		const user = isRecord(payload.user) ? payload.user : undefined;
		return {
			accessToken,
			refreshToken,
			expiresAt: Date.now() + Math.floor(expiresIn * 1_000),
			...(stringValue(user?.email) ? { email: stringValue(user?.email) } : {}),
		};
	}
}

export { ANYU_PROVIDER_ID };
