import { afterEach, describe, expect, it, vi } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { parseMetaRateLimitHeaders } from "@oh-my-pi/pi-ai/usage/meta";

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

function metaKeyRow(id: number): StoredAuthCredential {
	return {
		id,
		provider: "meta",
		credential: { type: "api_key", key: `meta-key-${id}`, source: "login" },
		disabledCause: null,
	};
}

function rateLimitHeaders(tokensRemaining: number, requestsRemaining = 80): Record<string, string> {
	return {
		"x-ratelimit-limit-tokens": "1000",
		"x-ratelimit-remaining-tokens": String(tokensRemaining),
		"x-ratelimit-limit-requests": "100",
		"x-ratelimit-remaining-requests": String(requestsRemaining),
	};
}

describe("Meta usage headers", () => {
	const storages: AuthStorage[] = [];

	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
		vi.restoreAllMocks();
	});

	async function createStorage(
		rows: StoredAuthCredential[],
		options?: {
			usageFetch?: typeof fetch;
			configValueResolver?: (value: string) => Promise<string | undefined>;
		},
	): Promise<AuthStorage> {
		const storage = new AuthStorage(makeStore(rows), {
			configValueResolver: options?.configValueResolver ?? (async value => value),
			...(options?.usageFetch ? { usageFetch: options.usageFetch } : {}),
		});
		await storage.reload();
		storages.push(storage);
		return storage;
	}

	it("normalizes healthy per-team token and request headroom", () => {
		const report = parseMetaRateLimitHeaders(rateLimitHeaders(750, 60), 1234);
		expect(report).not.toBeNull();
		expect(report?.provider).toBe("meta");
		expect(report?.fetchedAt).toBe(1234);
		expect(report?.metadata).toEqual({ source: "ratelimit-headers", scope: "team" });
		expect(report?.limits).toEqual([
			expect.objectContaining({
				id: "meta:tokens:1m",
				status: "ok",
				amount: {
					used: 250,
					limit: 1000,
					remaining: 750,
					usedFraction: 0.25,
					remainingFraction: 0.75,
					unit: "tokens",
				},
			}),
			expect.objectContaining({
				id: "meta:requests:1m",
				status: "ok",
				amount: expect.objectContaining({ remainingFraction: 0.6, unit: "requests" }),
			}),
		]);
	});

	it("maps near-limit remaining capacity to warning", () => {
		const report = parseMetaRateLimitHeaders(rateLimitHeaders(50));
		expect(report?.limits[0]).toMatchObject({
			status: "warning",
			amount: { usedFraction: 0.95, remainingFraction: 0.05 },
		});
	});

	it("maps zero remaining capacity to exhausted", () => {
		const report = parseMetaRateLimitHeaders(rateLimitHeaders(0, 0));
		expect(report?.limits.map(limit => limit.status)).toEqual(["exhausted", "exhausted"]);
	});

	it("accepts a partial response without inventing reset data", () => {
		const report = parseMetaRateLimitHeaders({
			"x-ratelimit-limit-tokens": "1000",
			"x-ratelimit-remaining-tokens": "500",
		});
		expect(report?.limits).toHaveLength(1);
		expect(report?.limits[0]?.window).toEqual({ id: "1m", label: "Per Minute", durationMs: 60_000 });
	});

	it("rejects malformed or incomplete quota headers", () => {
		expect(
			parseMetaRateLimitHeaders({
				"x-ratelimit-limit-tokens": "not-a-number",
				"x-ratelimit-remaining-tokens": "50",
			}),
		).toBeNull();
		expect(parseMetaRateLimitHeaders({ "x-ratelimit-limit-tokens": "1000" })).toBeNull();
		expect(parseMetaRateLimitHeaders({})).toBeNull();
	});

	it("registers the default Meta provider and routes from exact key headroom", async () => {
		const storage = await createStorage([metaKeyRow(1)]);
		expect(await storage.getApiKey("meta", "session")).toBe("meta-key-1");
		expect(await storage.ingestUsageHeaders("meta", rateLimitHeaders(700), { sessionId: "session" })).toBe(true);

		const reports = await storage.fetchUsageReports();
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.provider).toBe("meta");
		const health = await storage.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]).toMatchObject({ credentialId: 1, state: "healthy", remainingFraction: 0.7 });
	});

	it("uses the resolved login key for header and read cache identity", async () => {
		const row = metaKeyRow(1);
		if (row.credential.type !== "api_key") throw new Error("expected API-key fixture");
		row.credential.key = "META_TEST_KEY_REFERENCE";
		const storage = await createStorage([row], {
			configValueResolver: async value => (value === "META_TEST_KEY_REFERENCE" ? "resolved-meta-key" : value),
		});
		expect(await storage.getApiKey("meta", "session")).toBe("resolved-meta-key");
		expect(await storage.ingestUsageHeaders("meta", rateLimitHeaders(700), { sessionId: "session" })).toBe(true);
		expect(await storage.fetchUsageReports()).toHaveLength(1);
	});

	it("feeds exact API-key overlays into passive broker routing health", async () => {
		const row = metaKeyRow(1);
		if (row.credential.type !== "api_key") throw new Error("expected API-key fixture");
		row.credential.key = "META_BROKER_KEY_REFERENCE";
		const store = makeStore([row]);
		const overlays = new Map<string, UsageReport>();
		store.ingestUsageReport = (_provider, credential, report) => {
			if (credential.type !== "api_key") return false;
			overlays.set(credential.key, report);
			return true;
		};
		store.peekCachedUsageReport = (_provider, credential) =>
			credential.type === "api_key" ? (overlays.get(credential.key) ?? null) : null;
		const storage = new AuthStorage(store, {
			configValueResolver: async value => (value === "META_BROKER_KEY_REFERENCE" ? "resolved-broker-key" : value),
		});
		await storage.reload();
		storages.push(storage);
		await storage.getApiKey("meta", "session");
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(700), { sessionId: "session" });

		const health = storage.peekBrokerModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("healthy");
		expect(health.accounts[0]).toMatchObject({ credentialId: 1, state: "healthy", remainingFraction: 0.7 });
	});

	it("keeps missing and unreachable Meta usage unknown without probing a guessed endpoint", async () => {
		const usageFetch = vi.fn(() => {
			throw new Error("network must not be called");
		}) as unknown as typeof fetch;
		const storage = await createStorage([metaKeyRow(1)], { usageFetch });
		const reports = await storage.fetchUsageReports();
		expect(reports).toEqual([]);
		expect(usageFetch).not.toHaveBeenCalled();
		expect(storage.getUsageHealth()).toEqual([]);
		const health = await storage.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("unknown");
	});

	it("bounds header last-good state and degrades stale data to unknown", async () => {
		let now = 1_800_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const storage = await createStorage([metaKeyRow(1)]);
		await storage.getApiKey("meta", "session");
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(700), { sessionId: "session" });
		expect(
			(
				await storage.getModelUsageHealth("meta", {
					modelId: "muse-spark-1.2",
					reserveFraction: 0.1,
					cachedOnly: true,
				})
			).state,
		).toBe("healthy");

		now += 60_001;
		expect(
			(
				await storage.getModelUsageHealth("meta", {
					modelId: "muse-spark-1.2",
					reserveFraction: 0.1,
					cachedOnly: true,
				})
			).state,
		).toBe("unknown");
	});

	it("depletes routing on an exhausted Meta header", async () => {
		const storage = await createStorage([metaKeyRow(1)]);
		await storage.getApiKey("meta", "session");
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(0), { sessionId: "session" });
		const health = await storage.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("depleted");
		expect(health.accounts[0]?.state).toBe("depleted");
	});

	it("keeps low positive Meta headroom in reserve rather than exhausted", async () => {
		const storage = await createStorage([metaKeyRow(1)]);
		await storage.getApiKey("meta", "session");
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(50), { sessionId: "session" });
		const health = await storage.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		expect(health.state).toBe("reserve");
		expect(health.accounts[0]?.state).toBe("reserve");
		expect(health.accounts[0]?.remainingFraction).toBeCloseTo(0.05);
	});

	it("isolates header headroom by Meta credential", async () => {
		const storage = await createStorage([metaKeyRow(1), metaKeyRow(2)]);
		const keyA = await storage.getApiKey("meta", "session-a");
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(0), { sessionId: "session-a" });
		const keyB = await storage.getApiKey("meta", "session-b");
		expect(keyB).not.toBe(keyA);
		await storage.ingestUsageHeaders("meta", rateLimitHeaders(800), { sessionId: "session-b" });

		const health = await storage.getModelUsageHealth("meta", {
			modelId: "muse-spark-1.2",
			reserveFraction: 0.1,
			cachedOnly: true,
		});
		const exhaustedId = keyA === "meta-key-1" ? 1 : 2;
		const healthyId = exhaustedId === 1 ? 2 : 1;
		expect(health.accounts.find(account => account.credentialId === exhaustedId)).toMatchObject({
			state: "depleted",
		});
		expect(health.accounts.find(account => account.credentialId === healthyId)).toMatchObject({
			state: "healthy",
			remainingFraction: 0.8,
		});
	});

	it("rejects quota headers from a non-Meta base URL", async () => {
		const storage = await createStorage([metaKeyRow(1)]);
		await storage.getApiKey("meta", "session");
		expect(
			await storage.ingestUsageHeaders("meta", rateLimitHeaders(700), {
				sessionId: "session",
				baseUrl: "https://example.invalid/v1",
			}),
		).toBe(false);
	});
});
