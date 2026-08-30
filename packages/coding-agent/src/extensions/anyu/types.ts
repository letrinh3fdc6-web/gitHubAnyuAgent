import type { Api } from "@earendil-works/pi-ai";

export const ANYU_PROVIDER_ID = "anyu";
export const DEFAULT_ANYU_BASE_URL = "https://x.ailzd.com";

export type AnyuApi = "openai-responses" | "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface AnyuAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	email?: string;
}

export interface AnyuLoginResult {
	type: "authenticated";
	tokens: AnyuAuthTokens;
}

export interface AnyuTwoFactorResult {
	type: "two_factor";
	tempToken: string;
	maskedEmail?: string;
}

export type AnyuLoginResponse = AnyuLoginResult | AnyuTwoFactorResult;

export interface AnyuModelMetadata {
	id: string;
	name?: string;
	displayName?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
	api?: AnyuApi;
	baseUrl?: string;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
}

export interface AnyuCatalog {
	version?: number | string;
	expiresAt?: string;
	models: AnyuModelMetadata[];
}

export function isAnyuApi(api: Api): api is AnyuApi {
	return (
		api === "openai-responses" ||
		api === "openai-completions" ||
		api === "anthropic-messages" ||
		api === "google-generative-ai"
	);
}
