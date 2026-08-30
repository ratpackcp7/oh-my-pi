import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	SqliteAuthCredentialStore,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	RemoteAuthCredentialStore,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/oauth";
import { loginMetaApiKey, metaProvider } from "@oh-my-pi/pi-ai/registry/meta";
import {
	loginMetaOAuth,
	META_CLIENT_ID,
	META_DEVICE_AUTHORIZATION_URL,
	META_DEVICE_TOKEN_URL,
	META_KEY_MINT_URL,
	META_MINTED_KEY_TTL_MS,
	refreshMetaOAuthToken,
} from "@oh-my-pi/pi-ai/registry/oauth/meta";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	META_SUBSCRIPTION_WEEKLY_LIMIT_ID,
	META_SUBSCRIPTION_WINDOW_LIMIT_ID,
	metaRankingStrategy,
	parseMetaSubscriptionUsage,
} from "@oh-my-pi/pi-ai/usage/meta";
import { removeWithRetries } from "../../utils/src/temp";

const SYNTHETIC_IDENTITY_TOKEN = "synthetic-meta-identity-token-aa11";
const SYNTHETIC_MINTED_KEY = "synthetic-meta-minted-key-bb22";
const SYNTHETIC_PAYG_KEY = "synthetic-meta-payg-key-cc33";
const BROKER_TOKEN = "meta-muse-subscription-broker-token";

const WINDOW_RESET = "2026-09-01T12:00:00.000Z";
const WEEKLY_RESET = "2026-09-05T18:30:00.000Z";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

function makeStore(rows: StoredAuthCredential[]): AuthCredentialStore {
	const cache = new Map<string, CacheEntry>();
	return {
		close() {},
		listAuthCredentials: provider => rows.filter(row => provider === undefined || row.provider === provider),
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches: () => false,
		replaceAuthCredentialsForProvider: () => rows,
		upsertAuthCredentialForProvider: () => rows,
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			return entry && entry.expiresAtSec * 1000 > Date.now() ? entry.value : null;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

function subscriptionEvent(overrides?: {
	windowUsedPercent?: number;
	windowDurationMins?: number;
	weeklyUsedPercent?: number;
}): Record<string, unknown> {
	return {
		type: "response.subscription_usage",
		window: {
			used_percent: overrides?.windowUsedPercent ?? 25,
			window_duration_mins: overrides?.windowDurationMins ?? 300,
			resets_at: WINDOW_RESET,
		},
		weekly: {
			used_percent: overrides?.weeklyUsedPercent ?? 10,
			resets_at: WEEKLY_RESET,
		},
	};
}

type RecordedRequest = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestForm(request: RecordedRequest | undefined): URLSearchParams {
	const body = request?.init?.body;
	if (body instanceof URLSearchParams) return body;
	if (typeof body === "string") return new URLSearchParams(body);
	throw new Error("expected urlencoded body");
}

function noopMetaRefresh(
	_provider: string,
	_id: number,
	credential: { type: string; access: string; refresh: string; expires: number },
): Promise<OAuthCredentials> {
	if (credential.type !== "oauth") throw new Error("expected oauth credential");
	return Promise.resolve({
		refresh: credential.refresh,
		access: credential.access,
		expires: credential.expires,
	});
}

function deviceAuthorizationResponse() {
	return {
		device_code: "meta-device-code-xyz",
		user_code: "WXYZ-1234",
		verification_uri: "https://auth.meta.com/device",
		verification_uri_complete: "https://auth.meta.com/device?user_code=WXYZ-1234",
		expires_in: 600,
		interval: 1,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Meta Muse OAuth device login", () => {
	it("posts the device authorization contract and surfaces callback fields", async () => {
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) {
				return jsonResponse({ access_token: SYNTHETIC_IDENTITY_TOKEN });
			}
			if (url === META_KEY_MINT_URL) return jsonResponse({ api_key: SYNTHETIC_MINTED_KEY });
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		const authEvents: Array<{ url: string; instructions?: string }> = [];
		await loginMetaOAuth({
			fetch: fetchMock,
			onAuth: info => authEvents.push(info),
			onProgress: () => {},
		});

		const deviceRequest = requests.find(request => request.url === META_DEVICE_AUTHORIZATION_URL);
		expect(deviceRequest?.init?.method).toBe("POST");
		const deviceHeaders = new Headers(deviceRequest?.init?.headers);
		expect(deviceHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(deviceHeaders.get("Accept")).toBe("application/json");
		expect(Object.fromEntries(requestForm(deviceRequest))).toEqual({ client_id: META_CLIENT_ID });
		expect(authEvents).toEqual([
			{
				url: "https://auth.meta.com/device?user_code=WXYZ-1234",
				instructions: "Enter code: WXYZ-1234",
			},
		]);
	});

	it("polls authorization_pending then succeeds", async () => {
		let tokenPolls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) {
				tokenPolls += 1;
				if (tokenPolls === 1) {
					return jsonResponse({ error: "authorization_pending" }, 400);
				}
				return jsonResponse({ access_token: SYNTHETIC_IDENTITY_TOKEN });
			}
			if (url === META_KEY_MINT_URL) return jsonResponse({ api_key: SYNTHETIC_MINTED_KEY });
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		const credentials = await loginMetaOAuth({
			fetch: fetchMock,
			onAuth: () => {},
			onProgress: () => {},
		});
		expect(tokenPolls).toBe(2);
		expect(credentials.access).toBe(SYNTHETIC_MINTED_KEY);
		expect(credentials.refresh).toBe(SYNTHETIC_IDENTITY_TOKEN);
	});

	it("handles slow_down polling", async () => {
		let tokenPolls = 0;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) {
				tokenPolls += 1;
				if (tokenPolls === 1) return jsonResponse({ error: "slow_down" }, 400);
				return jsonResponse({ access_token: SYNTHETIC_IDENTITY_TOKEN });
			}
			if (url === META_KEY_MINT_URL) return jsonResponse({ api_key: SYNTHETIC_MINTED_KEY });
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		await loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} });
		expect(tokenPolls).toBe(2);
	}, 10_000);

	it("rejects denied authorization", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) return jsonResponse({ error: "access_denied" }, 400);
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		await expect(loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} })).rejects.toThrow(
			/denied/i,
		);
	});

	it("rejects expired authorization", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) return jsonResponse({ error: "expired_token" }, 400);
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		await expect(loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} })).rejects.toThrow(
			/expired/i,
		);
	});

	it("rejects cancelled login via abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchMock = vi.fn() as FetchImpl;
		await expect(
			loginMetaOAuth({
				fetch: fetchMock,
				signal: controller.signal,
				onAuth: () => {},
				onProgress: () => {},
			}),
		).rejects.toThrow(/cancel/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("mints with the exact endpoint, method, headers, and body", async () => {
		const requests: RecordedRequest[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push({ url, init });
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) return jsonResponse({ access_token: SYNTHETIC_IDENTITY_TOKEN });
			if (url === META_KEY_MINT_URL) return jsonResponse({ api_key: SYNTHETIC_MINTED_KEY });
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		await loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} });
		const mintRequest = requests.find(request => request.url === META_KEY_MINT_URL);
		expect(mintRequest?.init?.method).toBe("POST");
		const mintHeaders = new Headers(mintRequest?.init?.headers);
		expect(mintHeaders.get("Authorization")).toBe(`Bearer ${SYNTHETIC_IDENTITY_TOKEN}`);
		expect(mintHeaders.get("Accept")).toBe("application/json");
		expect(mintHeaders.get("Content-Type")).toBe("application/json");
		expect(mintHeaders.get("x-api-version")).toBe("1.0.0");
		expect(mintRequest?.init?.body).toBe("{}");
	});

	it("surfaces action_url setup failures without leaking secrets", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_DEVICE_AUTHORIZATION_URL) return jsonResponse(deviceAuthorizationResponse());
			if (url === META_DEVICE_TOKEN_URL) return jsonResponse({ access_token: SYNTHETIC_IDENTITY_TOKEN });
			if (url === META_KEY_MINT_URL) {
				return jsonResponse({ action_url: "https://www.meta.com/billing/setup" }, 402);
			}
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;

		await expect(loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} })).rejects.toThrow(
			/billing\/setup/,
		);
		await expect(loginMetaOAuth({ fetch: fetchMock, onAuth: () => {}, onProgress: () => {} })).rejects.not.toThrow(
			new RegExp(SYNTHETIC_IDENTITY_TOKEN),
		);
	});

	it("refresh re-mints from stored identity token without interactive flow", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === META_KEY_MINT_URL) return jsonResponse({ api_key: "refreshed-minted-key" });
			throw new Error(`unexpected url ${url}`);
		}) as FetchImpl;
		const refreshed = await refreshMetaOAuthToken(
			{
				refresh: SYNTHETIC_IDENTITY_TOKEN,
				access: "stale-minted-key",
				expires: Date.now() - 1,
			},
			fetchMock,
		);
		expect(refreshed.access).toBe("refreshed-minted-key");
		expect(refreshed.refresh).toBe(SYNTHETIC_IDENTITY_TOKEN);
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});

	it("OAuth credential returns minted key to request transport", async () => {
		const now = 1_900_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(now);
		const credentials: OAuthCredentials = {
			refresh: SYNTHETIC_IDENTITY_TOKEN,
			access: SYNTHETIC_MINTED_KEY,
			expires: now + META_MINTED_KEY_TTL_MS,
		};
		const resolved = await getOAuthApiKey("meta", { meta: credentials });
		expect(resolved?.apiKey).toBe(SYNTHETIC_MINTED_KEY);
		expect(metaProvider.getApiKey?.(credentials)).toBe(SYNTHETIC_MINTED_KEY);
	});

	it("API-key login still works and does not become OAuth implicitly", async () => {
		const apiKey = await loginMetaApiKey({
			onAuth: () => {},
			onPrompt: async () => SYNTHETIC_PAYG_KEY,
			fetch: (input, init) => {
				expect(String(input)).toBe("https://api.meta.ai/v1/models");
				expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${SYNTHETIC_PAYG_KEY}`);
				return Promise.resolve(Response.json({ data: [{ id: "muse-spark-1.2" }] }));
			},
		});
		expect(apiKey).toBe(SYNTHETIC_PAYG_KEY);
	});
});

describe("Meta Muse subscription usage parsing", () => {
	const now = 1_900_000_000_000;

	it("normalizes valid window and weekly snapshots", () => {
		const report = parseMetaSubscriptionUsage(subscriptionEvent(), now);
		expect(report).not.toBeNull();
		expect(report?.metadata).toEqual({ source: "subscription-usage", scope: "subscription" });
		expect(report?.limits).toHaveLength(2);
		const windowLimit = report?.limits.find(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID);
		const weeklyLimit = report?.limits.find(limit => limit.id === META_SUBSCRIPTION_WEEKLY_LIMIT_ID);
		expect(windowLimit).toMatchObject({
			amount: {
				used: 25,
				usedFraction: 0.25,
				remainingFraction: 0.75,
				unit: "percent",
			},
			window: {
				durationMs: 300 * 60_000,
				resetsAt: Date.parse(WINDOW_RESET),
			},
		});
		expect(weeklyLimit).toMatchObject({
			amount: {
				used: 10,
				usedFraction: 0.1,
				remainingFraction: 0.9,
				unit: "percent",
			},
			window: {
				resetsAt: Date.parse(WEEKLY_RESET),
			},
		});
	});

	it("rejects negative window.used_percent", () => {
		expect(parseMetaSubscriptionUsage(subscriptionEvent({ windowUsedPercent: -1 }))).toBeNull();
	});

	it("rejects negative weekly.used_percent", () => {
		expect(parseMetaSubscriptionUsage(subscriptionEvent({ weeklyUsedPercent: -5 }))).toBeNull();
	});

	it("rejects zero window_duration_mins", () => {
		expect(parseMetaSubscriptionUsage(subscriptionEvent({ windowDurationMins: 0 }))).toBeNull();
	});

	it("preserves dynamic window duration", () => {
		const report = parseMetaSubscriptionUsage(subscriptionEvent({ windowDurationMins: 180 }), now);
		const windowLimit = report?.limits.find(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID);
		expect(windowLimit?.window?.durationMs).toBe(180 * 60_000);
		expect(windowLimit?.window?.id).toBe("rolling-180m");
	});

	it("preserves reset timestamps without inventing time zones", () => {
		const report = parseMetaSubscriptionUsage(subscriptionEvent(), now);
		expect(report?.limits[0]?.window?.resetsAt).toBe(Date.parse(WINDOW_RESET));
		expect(report?.limits[1]?.window?.resetsAt).toBe(Date.parse(WEEKLY_RESET));
	});

	it("clamps routing fractions above 100% while preserving raw used percent", () => {
		const report = parseMetaSubscriptionUsage(subscriptionEvent({ windowUsedPercent: 150 }), now);
		const windowLimit = report?.limits.find(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID);
		expect(windowLimit?.amount.used).toBe(150);
		expect(windowLimit?.amount.usedFraction).toBe(1);
		expect(windowLimit?.amount.remainingFraction).toBe(0);
		expect(windowLimit?.status).toBe("exhausted");
	});

	it("routing window selection uses subscription limits when present", () => {
		const report = parseMetaSubscriptionUsage(subscriptionEvent(), now)!;
		const windows = metaRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe(META_SUBSCRIPTION_WINDOW_LIMIT_ID);
		expect(windows.secondary?.id).toBe(META_SUBSCRIPTION_WEEKLY_LIMIT_ID);
	});
});

describe("Meta Muse subscription usage ingest isolation", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	afterEach(async () => {
		storage?.close();
		store?.close();
		await handle?.close();
		if (tempDir) await removeWithRetries(tempDir);
	});

	it("ingests subscription usage for OAuth credentials", async () => {
		const previousMetaEnv = process.env.META_API_KEY;
		const previousModelEnv = process.env.MODEL_API_KEY;
		delete process.env.META_API_KEY;
		delete process.env.MODEL_API_KEY;
		try {
			storage = new AuthStorage(
				makeStore([
					{
						id: 1,
						provider: "meta",
						credential: {
							type: "oauth",
							access: "mint-a",
							refresh: "identity-a",
							expires: Date.now() + 60_000,
						},
						disabledCause: null,
					},
				]),
				{ refreshOAuthCredential: noopMetaRefresh },
			);
			await storage.reload();
			expect(storage.ingestUsageSubscriptionEvent("meta", subscriptionEvent())).toBe(true);
			const reports = await storage.fetchUsageReports();
			expect(
				reports?.[0]?.limits.find(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID)?.amount
					.remainingFraction,
			).toBeCloseTo(0.75);
		} finally {
			if (previousMetaEnv === undefined) delete process.env.META_API_KEY;
			else process.env.META_API_KEY = previousMetaEnv;
			if (previousModelEnv === undefined) delete process.env.MODEL_API_KEY;
			else process.env.MODEL_API_KEY = previousModelEnv;
		}
	});

	it("keeps PAYG header usage separate from subscription semantics", async () => {
		const previousMetaEnv = process.env.META_API_KEY;
		const previousModelEnv = process.env.MODEL_API_KEY;
		delete process.env.META_API_KEY;
		delete process.env.MODEL_API_KEY;
		try {
			storage = new AuthStorage(
				makeStore([
					{
						id: 2,
						provider: "meta",
						credential: { type: "api_key", key: SYNTHETIC_PAYG_KEY, source: "login" },
						disabledCause: null,
					},
				]),
			);
			await storage.reload();
			await storage.getApiKey("meta", "payg-session");
			expect(
				await storage.ingestUsageHeaders(
					"meta",
					{
						"x-ratelimit-limit-tokens": "1000",
						"x-ratelimit-remaining-tokens": "500",
						"x-ratelimit-limit-requests": "100",
						"x-ratelimit-remaining-requests": "50",
					},
					{ sessionId: "payg-session" },
				),
			).toBe(true);
			const health = await storage.getModelUsageHealth("meta", {
				modelId: "muse-spark-1.2",
				reserveFraction: 0.1,
				cachedOnly: true,
			});
			expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.5);
			const windows = metaRankingStrategy.findWindowLimits(
				(await storage.fetchUsageReports())?.[0] ?? { provider: "meta", fetchedAt: Date.now(), limits: [] },
			);
			expect(windows.primary?.id).toBe("meta:tokens:1m");
			expect(windows.secondary?.id).toBe("meta:requests:1m");
		} finally {
			if (previousMetaEnv === undefined) delete process.env.META_API_KEY;
			else process.env.META_API_KEY = previousMetaEnv;
			if (previousModelEnv === undefined) delete process.env.MODEL_API_KEY;
			else process.env.MODEL_API_KEY = previousModelEnv;
		}
	});

	it("broker durability: another client sees subscription report after ingest", async () => {
		const previousMetaEnv = process.env.META_API_KEY;
		const previousModelEnv = process.env.MODEL_API_KEY;
		delete process.env.META_API_KEY;
		delete process.env.MODEL_API_KEY;
		try {
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-muse-sub-broker-"));
			store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
			store.upsertAuthCredentialForProvider("meta", {
				type: "oauth",
				access: SYNTHETIC_MINTED_KEY,
				refresh: SYNTHETIC_IDENTITY_TOKEN,
				expires: Date.now() + META_MINTED_KEY_TTL_MS,
			});
			storage = new AuthStorage(store, { refreshOAuthCredential: noopMetaRefresh });
			await storage.reload();
			handle = startAuthBroker({
				storage,
				bind: "127.0.0.1:0",
				bearerTokens: [BROKER_TOKEN],
				disableRefresher: true,
			});

			const clientA = new AuthBrokerClient({ url: handle.url, token: BROKER_TOKEN });
			const remoteA = new RemoteAuthCredentialStore({ client: clientA, streamSnapshots: false });
			await remoteA.refreshSnapshot();
			const storageA = new AuthStorage(remoteA, { refreshOAuthCredential: noopMetaRefresh });
			await storageA.reload();
			expect(
				await storageA.ingestUsageSubscriptionEvent("meta", subscriptionEvent(), { sessionId: "broker-session" }),
			).toBe(true);
			remoteA.close();
			storageA.close();

			const clientB = new AuthBrokerClient({ url: handle.url, token: BROKER_TOKEN });
			const remoteB = new RemoteAuthCredentialStore({ client: clientB, streamSnapshots: false });
			await remoteB.refreshSnapshot();
			const storageB = new AuthStorage(remoteB);
			await storageB.reload();
			const reports = await storageB.fetchUsageReports();
			const subscriptionReport = reports?.find(report =>
				report.limits.some(limit => limit.id === META_SUBSCRIPTION_WINDOW_LIMIT_ID),
			);
			expect(subscriptionReport?.limits[0]?.amount.remainingFraction).toBeCloseTo(0.75);
			const wire = await fetch(`${handle.url}/v1/usage`, {
				headers: { Authorization: `Bearer ${BROKER_TOKEN}` },
			}).then(response => response.json() as Promise<{ reports: UsageReport[] }>);
			expect(JSON.stringify(wire)).not.toContain(SYNTHETIC_IDENTITY_TOKEN);
			expect(JSON.stringify(wire)).not.toContain(SYNTHETIC_MINTED_KEY);
			remoteB.close();
			storageB.close();
		} finally {
			if (previousMetaEnv === undefined) delete process.env.META_API_KEY;
			else process.env.META_API_KEY = previousMetaEnv;
			if (previousModelEnv === undefined) delete process.env.MODEL_API_KEY;
			else process.env.MODEL_API_KEY = previousModelEnv;
		}
	});
});
