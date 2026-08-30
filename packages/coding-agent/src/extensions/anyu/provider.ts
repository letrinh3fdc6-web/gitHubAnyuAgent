import type {
	Api,
	AuthResult,
	Model,
	OAuthAuth,
	OAuthCredential,
	Provider,
	ProviderAuthInteraction,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { AnyuClient, toPiModelConfig } from "./client.ts";
import { ANYU_PROVIDER_ID, type AnyuAuthTokens, DEFAULT_ANYU_BASE_URL, isAnyuApi } from "./types.ts";

function toCredential(tokens: AnyuAuthTokens): OAuthCredential {
	return {
		type: "oauth",
		access: tokens.accessToken,
		refresh: tokens.refreshToken,
		expires: tokens.expiresAt,
		...(tokens.email ? { email: tokens.email } : {}),
	};
}

export interface AnyuProviderController {
	provider: Provider;
	setModels(models: readonly Model<Api>[]): void;
}

export function createAnyuProvider(
	options: { baseUrl?: string; fetch?: typeof globalThis.fetch } = {},
): AnyuProviderController {
	const client = new AnyuClient({
		baseUrl: options.baseUrl ?? process.env.ANYU_BASE_URL ?? DEFAULT_ANYU_BASE_URL,
		fetch: options.fetch,
	});
	let models: readonly Model<Api>[] = [];
	const oauth: OAuthAuth = {
		name: "Anyu account",
		login: async (interaction: ProviderAuthInteraction): Promise<OAuthCredential> => {
			const email = (await interaction.prompt({ type: "text", message: "Anyu email" })).trim();
			const password = await interaction.prompt({ type: "secret", message: "Anyu password" });
			const result = await client.login(email, password, interaction.signal);
			if (result.type === "two_factor") {
				interaction.notify({ type: "progress", message: "Two-factor authentication required." });
				const code = await interaction.prompt({ type: "text", message: "Anyu two-factor code" });
				return toCredential(await client.login2FA(result.tempToken, code.trim(), interaction.signal));
			}
			return toCredential(result.tokens);
		},
		refresh: async (credential, signal) => toCredential(await client.refresh(credential.refresh, signal)),
		toAuth: async (credential): Promise<AuthResult["auth"]> => ({
			headers: { Authorization: `Bearer ${credential.access}` },
		}),
	};
	const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
		if (context.stored?.models) {
			const restored = context.stored.models.filter(
				(model): model is Model<Api> => model.provider === ANYU_PROVIDER_ID && isAnyuApi(model.api),
			);
			await context.publish({
				update: () => {
					models = restored;
				},
			});
		}
		if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "oauth") return;
		const catalog = await client.catalog(context.credential.access, context.signal);
		const refreshed = catalog.models
			.map(toPiModelConfig)
			.map((model) => ({ ...model, provider: ANYU_PROVIDER_ID }) as Model<Api>);
		await context.publish({
			persist: { models: refreshed, checkedAt: Date.now() },
			update: () => {
				models = refreshed;
			},
		});
	};
	const provider: Provider = {
		id: ANYU_PROVIDER_ID,
		name: "Anyu",
		baseUrl: `${client.baseUrl}/v1`,
		auth: { oauth },
		getModels: () => models,
		refreshModels,
		stream: (model, context, options) => {
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return api.stream(model, context, options);
		},
		streamSimple: (model, context, options) => {
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return api.streamSimple(model, context, options);
		},
	};
	return {
		provider,
		setModels: (next) => {
			models = [...next];
		},
	};
}
