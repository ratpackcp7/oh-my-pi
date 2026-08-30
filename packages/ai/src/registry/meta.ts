import { createApiKeyLogin } from "./api-key-login";
import { loginMetaOAuth, refreshMetaOAuthToken } from "./oauth/meta";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginMetaApiKey = createApiKeyLogin({
	providerLabel: "Meta Model API",
	authUrl: "https://developer.meta.com/ai/",
	instructions: "Create or copy your key from the Meta Model API dashboard",
	promptMessage: "Paste your Meta Model API key",
	placeholder: "Model API key",
	validation: {
		kind: "models-endpoint",
		provider: "Meta Model API",
		modelsUrl: "https://api.meta.ai/v1/models",
	},
});

/** @deprecated Use {@link loginMetaApiKey} for PAYG API-key paste login. */
export const loginMeta = loginMetaApiKey;

export const metaProvider = {
	id: "meta",
	name: "Meta Model API",
	envKeys: "META_API_KEY",
	login: (cb: OAuthLoginCallbacks) => loginMetaOAuth(cb),
	refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) =>
		refreshMetaOAuthToken(credentials, undefined, signal),
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
} as const satisfies ProviderDefinition;
