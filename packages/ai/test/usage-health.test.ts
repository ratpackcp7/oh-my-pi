/**
 * Tests for broker usage-health telemetry.
 *
 * Before this, `fetchUsageReports()` collapsed every failure into `null`
 * plus the last-good fallback, so a consumer of the broker's `GET /v1/usage`
 * couldn't tell "throttled" from "login revoked" from "network down" — it
 * only saw a report that stopped moving. `AuthStorage.getUsageHealth()`
 * recovers that distinction.
 *
 * Contract under test (AuthStorage side; the broker endpoint surfaces the same
 * entries as its optional `health` field):
 *
 *   `AuthStorage.getUsageHealth(): UsageProviderHealth[]`, one entry per polled
 *   provider, with `provider`, `lastAttemptAt` (every poll), `lastSuccessfulAt`
 *   (successful polls only; survives later failures), `errorCode`
 *   (`rate_limited` | `reauth_required` | `provider_unreachable` | `unknown`;
 *   absent while healthy) and `nextAllowedAt` (only when upstream said when to
 *   come back, e.g. a 429 `Retry-After`).
 *
 * Classification has to be observed at the usage fetch AuthStorage hands each
 * `UsageProvider`: providers like `claudeUsageProvider` deliberately swallow
 * HTTP failures and return `null`, so the status never reaches AuthStorage via
 * the return value. These tests therefore drive the real Anthropic usage
 * provider through an injected `usageFetch`.
 *
 * Retention is part of the same contract: a `rate_limited` poll keeps serving
 * the last good report; a `reauth_required` poll must not (quota behind a
 * revoked login is no longer a fact).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialStore,
	AuthStorage,
	type StoredAuthCredential,
} from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageProviderHealth, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

const ACCESS_TOKEN = "oat-secret-access-token";
const REFRESH_TOKEN = "oat-secret-refresh-token";

interface CacheEntry {
	value: string;
	expiresAtSec: number;
}

interface ObservableStore extends AuthCredentialStore {
	cache: Map<string, CacheEntry>;
}

/** Minimal in-memory `AuthCredentialStore` with an inspectable cache. */
function makeStore(rows: StoredAuthCredential[]): ObservableStore {
	const cache = new Map<string, CacheEntry>();
	return {
		cache,
		close() {},
		listAuthCredentials() {
			return rows;
		},
		updateAuthCredential() {},
		deleteAuthCredential() {},
		tryDisableAuthCredentialIfMatches() {
			return false;
		},
		replaceAuthCredentialsForProvider() {
			return rows;
		},
		upsertAuthCredentialForProvider() {
			return rows;
		},
		deleteAuthCredentialsForProvider() {},
		getCache(key) {
			const entry = cache.get(key);
			if (!entry) return null;
			if (entry.expiresAtSec * 1000 <= Date.now()) return null;
			return entry.value;
		},
		setCache(key, value, expiresAtSec) {
			cache.set(key, { value, expiresAtSec });
		},
		cleanExpiredCache() {},
	};
}

/**
 * Age every cache payload without dropping its value: the next poll refetches
 * while the last-good report stays reachable for the failure path. Equivalent
 * to advancing the clock past the success TTL (`bun:test` has no clock control
 * reaching AuthStorage's internal cache).
 */
function expireCachePayloads(store: ObservableStore): void {
	for (const [key, entry] of store.cache) {
		try {
			const parsed = JSON.parse(entry.value);
			parsed.expiresAt = 1; // positive but already in the past (epoch ms)
			store.cache.set(key, { value: JSON.stringify(parsed), expiresAtSec: entry.expiresAtSec });
		} catch {
			// Non-JSON entries — leave alone.
		}
	}
}

function oauthRow(): StoredAuthCredential {
	const credential: AuthCredential = {
		type: "oauth",
		access: ACCESS_TOKEN,
		refresh: REFRESH_TOKEN,
		expires: Date.now() + 3_600_000,
		accountId: "account-1",
		email: "a@example.com",
	};
	return { id: 1, provider: "anthropic", credential, disabledCause: null };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** Anthropic `/api/oauth/usage` success payload (five-hour window only). */
function usagePayload(utilization: number): Record<string, unknown> {
	return {
		five_hour: { utilization, resets_at: new Date(Date.now() + 5 * 60_000).toISOString() },
	};
}

/** Injected `usageFetch`: `handle` answers `/usage`; the profile probe gets an empty 200. */
function usageFetch(handle: () => Response | Promise<Response>): typeof fetch {
	return ((input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (!url.includes("/usage")) return Promise.resolve(jsonResponse(200, {}));
		return Promise.resolve(handle());
	}) as unknown as typeof fetch;
}

function anthropicReports(reports: UsageReport[] | null): UsageReport[] {
	return (reports ?? []).filter(report => report.provider === "anthropic");
}

/** `await` so the assertions hold whether the accessor is sync or async — the entries are the contract. */
async function anthropicHealth(storage: AuthStorage): Promise<UsageProviderHealth> {
	const entries = await storage.getUsageHealth();
	const entry = entries.find(candidate => candidate.provider === "anthropic");
	if (!entry) throw new Error("expected an anthropic usage health entry");
	return entry;
}

describe("AuthStorage usage health telemetry", () => {
	let store: ObservableStore;
	let storage: AuthStorage;

	function start(fetchImpl: typeof fetch, usageRequestTimeoutMs?: number): void {
		storage = new AuthStorage(store, {
			// Restrict the resolver to anthropic so a poll can't fan out to real
			// endpoints for whatever `*_API_KEY` env vars the test host has set.
			usageProviderResolver: provider => (provider === "anthropic" ? claudeUsageProvider : undefined),
			usageFetch: fetchImpl,
			...(usageRequestTimeoutMs === undefined ? {} : { usageRequestTimeoutMs }),
		});
	}

	beforeEach(() => {
		store = makeStore([oauthRow()]);
	});

	afterEach(() => {
		storage?.close();
	});

	it("marks a successful poll fresh, with lastSuccessfulAt tracking the attempt", async () => {
		start(usageFetch(() => jsonResponse(200, usagePayload(42))));
		await storage.reload();

		const before = Date.now();
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		const health = await anthropicHealth(storage);
		expect(health.errorCode).toBeUndefined();
		expect(health.nextAllowedAt).toBeUndefined();
		expect(health.lastSuccessfulAt).toBeGreaterThanOrEqual(before);
		expect(health.lastAttemptAt).toBeGreaterThanOrEqual(before);
	});

	it("reports rate_limited with a Retry-After-derived nextAllowedAt and keeps the last good report", async () => {
		let limited = false;
		start(
			usageFetch(() =>
				limited
					? jsonResponse(429, { type: "error", error: { type: "rate_limit_error" } }, { "retry-after": "120" })
					: jsonResponse(200, usagePayload(42)),
			),
		);
		await storage.reload();

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);
		const firstSuccessAt = (await anthropicHealth(storage)).lastSuccessfulAt;

		limited = true;
		expireCachePayloads(store);
		const beforeRetry = Date.now();
		const reports = anthropicReports(await storage.fetchUsageReports());

		// A throttled poll is not a lost account: the last good quota still shows.
		expect(reports).toHaveLength(1);
		expect(reports[0]?.limits.length).toBeGreaterThan(0);

		const health = await anthropicHealth(storage);
		expect(health.errorCode).toBe("rate_limited");
		// Retry-After: 120 → don't poll again for ~2 minutes.
		expect(health.nextAllowedAt).toBeGreaterThanOrEqual(beforeRetry + 119_000);
		expect(health.nextAllowedAt).toBeLessThanOrEqual(Date.now() + 121_000);
		// A failure moves the attempt clock, never the success clock.
		expect(health.lastSuccessfulAt).toBe(firstSuccessAt);
		expect(health.lastAttemptAt).toBeGreaterThanOrEqual(beforeRetry);
	});

	it("reports reauth_required on a 401 and stops serving the last good report", async () => {
		let revoked = false;
		start(
			usageFetch(() =>
				revoked
					? jsonResponse(401, { type: "error", error: { type: "authentication_error" } })
					: jsonResponse(200, usagePayload(42)),
			),
		);
		await storage.reload();

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		revoked = true;
		expireCachePayloads(store);
		const reports = anthropicReports(await storage.fetchUsageReports());

		// Quota behind a revoked login is not a fact — stop rendering it.
		expect(reports).toHaveLength(0);

		const health = await anthropicHealth(storage);
		expect(health.errorCode).toBe("reauth_required");
		// Nothing upstream said when the login will work again.
		expect(health.nextAllowedAt).toBeUndefined();
		expect(health.lastSuccessfulAt).toBeDefined();
	});

	it("reports provider_unreachable when the upstream connection fails", async () => {
		// Timeout bounds the provider's internal retry sleeps.
		start(
			usageFetch(() => Promise.reject(new TypeError("fetch failed"))),
			150,
		);
		await storage.reload();

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);

		const health = await anthropicHealth(storage);
		expect(health.errorCode).toBe("provider_unreachable");
		expect(health.nextAllowedAt).toBeUndefined();
		expect(health.lastSuccessfulAt).toBeUndefined();
		expect(health.lastAttemptAt).toBeGreaterThan(0);
	});

	it("reports provider_unreachable when the upstream request times out", async () => {
		const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) return;
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			})) as unknown as typeof fetch;
		start(hanging, 100);
		await storage.reload();

		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		expect((await anthropicHealth(storage)).errorCode).toBe("provider_unreachable");
	});

	it("clears the failure and advances lastSuccessfulAt once a later poll succeeds", async () => {
		let limited = true;
		start(
			usageFetch(() =>
				limited
					? jsonResponse(429, { type: "error", error: { type: "rate_limit_error" } }, { "retry-after": "60" })
					: jsonResponse(200, usagePayload(7)),
			),
		);
		await storage.reload();

		// Cold failure: nothing to fall back on.
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(0);
		const failed = await anthropicHealth(storage);
		expect(failed.errorCode).toBe("rate_limited");
		expect(failed.nextAllowedAt).toBeDefined();

		limited = false;
		expireCachePayloads(store);
		const beforeRecovery = Date.now();
		expect(anthropicReports(await storage.fetchUsageReports())).toHaveLength(1);

		const recovered = await anthropicHealth(storage);
		expect(recovered.errorCode).toBeUndefined();
		expect(recovered.nextAllowedAt).toBeUndefined();
		expect(recovered.lastSuccessfulAt).toBeGreaterThanOrEqual(beforeRecovery);
	});

	it("never exposes credential material in health telemetry", async () => {
		let revoked = false;
		start(
			usageFetch(() =>
				revoked
					? // Upstream echoes every secret the process holds back at us.
						jsonResponse(401, {
							type: "error",
							error: { type: "authentication_error", message: `bad token ${ACCESS_TOKEN} / ${REFRESH_TOKEN}` },
						})
					: jsonResponse(200, usagePayload(42)),
			),
		);
		await storage.reload();

		await storage.fetchUsageReports();
		revoked = true;
		expireCachePayloads(store);
		await storage.fetchUsageReports();

		const serialized = JSON.stringify(await storage.getUsageHealth());
		expect(serialized).not.toContain(ACCESS_TOKEN);
		expect(serialized).not.toContain(REFRESH_TOKEN);
		expect(serialized.toLowerCase()).not.toContain("bearer");
		expect(serialized.toLowerCase()).not.toContain("authorization");
	});
});
