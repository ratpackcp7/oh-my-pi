/**
 * Meta Muse OAuth device authorization and ephemeral Model API key minting.
 *
 * Subscription use requires Meta-account login; manually entered API keys follow
 * the separate PAYG Model API path and never run this flow.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import type { OAuthController, OAuthCredentials } from "./types";

export const META_AUTH_BASE = "https://auth.meta.com";
export const META_CLIENT_ID = "1031625952748946";
export const META_DEVICE_AUTHORIZATION_URL = `${META_AUTH_BASE}/oidc/device/authorization/`;
export const META_DEVICE_TOKEN_URL = `${META_AUTH_BASE}/oidc/device/token/`;
export const META_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
export const META_KEY_MINT_API_VERSION = "1.0.0";
export const META_MINTED_KEY_TTL_MS = 24 * 60 * 60 * 1000;

const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface MetaDeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUriComplete: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

interface MetaMintKeySuccess {
	apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return value;
}

function parseDeviceAuthorization(payload: unknown): MetaDeviceAuthorization {
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("Meta device authorization response was not an object", {
			kind: "validation",
			provider: "meta",
		});
	}
	const deviceCode = readString(payload, "device_code");
	const userCode = readString(payload, "user_code");
	const verificationUriComplete =
		readString(payload, "verification_uri_complete") ?? readString(payload, "verification_uri");
	const expiresInSeconds = readPositiveNumber(payload, "expires_in");
	const intervalSeconds = readPositiveNumber(payload, "interval") ?? 5;
	if (!deviceCode || !userCode || !verificationUriComplete || expiresInSeconds === undefined) {
		throw new AIError.OAuthError("Meta device authorization response missing required fields", {
			kind: "validation",
			provider: "meta",
		});
	}
	return { deviceCode, userCode, verificationUriComplete, expiresInSeconds, intervalSeconds };
}

async function requestMetaDeviceAuthorization(
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<MetaDeviceAuthorization> {
	const body = new URLSearchParams({ client_id: META_CLIENT_ID });
	const response = await fetchImpl(META_DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal,
	});
	if (!response.ok) {
		throw new AIError.OAuthError(`Meta device authorization failed: ${response.status}`, {
			kind: "device-auth",
			provider: "meta",
			status: response.status,
		});
	}
	return parseDeviceAuthorization(await response.json());
}

async function pollMetaDeviceToken(
	fetchImpl: FetchImpl,
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
	signal?: AbortSignal,
): Promise<string> {
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds,
		expiresInSeconds,
		signal,
		async poll() {
			const body = new URLSearchParams({
				grant_type: DEVICE_GRANT_TYPE,
				device_code: deviceCode,
				client_id: META_CLIENT_ID,
			});
			const response = await fetchImpl(META_DEVICE_TOKEN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body,
				signal,
			});
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				return { status: "failed", message: `Meta device token response was not JSON (${response.status})` };
			}
			if (response.ok && isRecord(payload)) {
				const accessToken = readString(payload, "access_token");
				if (accessToken) return { status: "complete", value: accessToken };
			}
			if (!isRecord(payload)) {
				return { status: "failed", message: `Meta device token failed: ${response.status}` };
			}
			const error = readString(payload, "error");
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") return { status: "slow_down" };
			if (error === "access_denied") {
				return { status: "failed", message: "Meta device authorization was denied" };
			}
			if (error === "expired_token") {
				return { status: "failed", message: "Meta device authorization expired" };
			}
			const description = readString(payload, "error_description");
			return {
				status: "failed",
				message: description ?? `Meta device token failed: ${error ?? response.status}`,
			};
		},
	});
}

export async function mintMetaModelApiKey(
	identityAccessToken: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<MetaMintKeySuccess> {
	const response = await fetchImpl(META_KEY_MINT_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${identityAccessToken}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-version": META_KEY_MINT_API_VERSION,
		},
		body: "{}",
		signal,
	});
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new AIError.OAuthError(`Meta API key mint failed: ${response.status}`, {
			kind: "validation",
			provider: "meta",
			status: response.status,
		});
	}
	if (!response.ok || !isRecord(payload)) {
		const actionUrl = isRecord(payload) ? readString(payload, "action_url") : undefined;
		if (actionUrl) {
			throw new AIError.OAuthError(
				`Meta Muse subscription setup is required before API access. Complete setup at ${actionUrl}`,
				{ kind: "validation", provider: "meta", status: response.status },
			);
		}
		throw new AIError.OAuthError(`Meta API key mint failed: ${response.status}`, {
			kind: "validation",
			provider: "meta",
			status: response.status,
		});
	}
	const apiKey = readString(payload, "api_key");
	if (!apiKey) {
		throw new AIError.OAuthError("Meta API key mint response missing api_key", {
			kind: "validation",
			provider: "meta",
		});
	}
	return { apiKey };
}

function buildMetaOAuthCredentials(identityAccessToken: string, mintedApiKey: string): OAuthCredentials {
	const now = Date.now();
	return {
		refresh: identityAccessToken,
		access: mintedApiKey,
		expires: now + META_MINTED_KEY_TTL_MS,
	};
}

/** Log in to Meta Muse with the OIDC device authorization grant and mint an ephemeral Model API key. */
export async function loginMetaOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = ctrl.fetch ?? fetch;
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();

	ctrl.onProgress?.("Initiating Meta device authorization…");
	const device = await requestMetaDeviceAuthorization(fetchImpl, ctrl.signal);
	ctrl.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	const identityToken = await pollMetaDeviceToken(
		fetchImpl,
		device.deviceCode,
		device.intervalSeconds,
		device.expiresInSeconds,
		ctrl.signal,
	);
	ctrl.onProgress?.("Minting Meta Model API key…");
	const minted = await mintMetaModelApiKey(identityToken, fetchImpl, ctrl.signal);
	return buildMetaOAuthCredentials(identityToken, minted.apiKey);
}

/** Re-mint the ephemeral Model API key from a stored Meta identity token. */
export async function refreshMetaOAuthToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const identityToken = credentials.refresh?.trim();
	if (!identityToken) {
		throw new AIError.OAuthError("Meta OAuth credentials are missing the identity token", {
			kind: "validation",
			provider: "meta",
		});
	}
	const minted = await mintMetaModelApiKey(identityToken, fetchImpl, signal);
	return {
		...credentials,
		access: minted.apiKey,
		expires: Date.now() + META_MINTED_KEY_TTL_MS,
	};
}
