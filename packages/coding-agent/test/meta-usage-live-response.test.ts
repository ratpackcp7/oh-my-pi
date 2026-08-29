import { afterEach, describe, expect, it } from "bun:test";
import type { Model, ProviderResponseMetadata } from "@oh-my-pi/pi-ai";
import { type AuthCredentialStore, AuthStorage, type StoredAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { SessionStatsTracker } from "../src/session/session-stats";

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

describe("Meta usage live response ingest", () => {
	const storages: AuthStorage[] = [];

	afterEach(() => {
		for (const storage of storages) storage.close();
		storages.length = 0;
	});

	it("SessionStatsTracker forwards provider response headers into AuthStorage usage reports", async () => {
		const storage = new AuthStorage(
			makeStore([
				{
					id: 1,
					provider: "meta",
					credential: { type: "api_key", key: "synthetic-meta-live-response-key", source: "login" },
					disabledCause: null,
				},
			]),
		);
		await storage.reload();
		storages.push(storage);

		const tracker = new SessionStatsTracker({
			session: { messages: [] },
			agent: {
				sessionId: "live-response-session",
				state: { messages: [] },
				tokenizer: { countMessages: () => 0 },
			},
			sessionManager: {} as never,
			modelRegistry: {
				authStorage: storage,
				getProviderBaseUrl: () => "https://api.meta.ai/v1",
			},
			model: () => undefined,
			sessionId: () => "live-response-session",
		});

		const model = { provider: "meta", id: "muse-spark-1.2" } as Model;
		const response: ProviderResponseMetadata = {
			headers: {
				"x-ratelimit-limit-tokens": "1000",
				"x-ratelimit-remaining-tokens": "700",
				"x-ratelimit-limit-requests": "100",
				"x-ratelimit-remaining-requests": "80",
			},
		};

		await storage.getApiKey("meta", "live-response-session");
		await tracker.ingestProviderUsageHeaders(response, model);

		const reports = await storage.fetchUsageReports();
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.limits[0]?.amount.remainingFraction).toBeCloseTo(0.7);
	});
});
