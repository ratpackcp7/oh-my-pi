import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { resolveResourcePool } from "@oh-my-pi/pi-coding-agent/task/routing/pool";
import { buildRoutingSnapshot } from "@oh-my-pi/pi-coding-agent/task/routing/snapshot";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const root = new URL("../src/", import.meta.url);
const readSource = async (relative: string) => Bun.file(new URL(relative, root)).text();

function sessionWithRegistry(
	auth: AuthStorage,
	registry: ModelRegistry,
	overrides: Record<string, unknown>,
): ToolSession {
	return {
		modelRegistry: registry,
		authStorage: auth,
		getSessionId: () => "test",
		getActiveModelString: () => "anthropic/claude-opus-4-5",
		settings: Settings.isolated(overrides as never),
	} as unknown as ToolSession;
}

const model = {
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	input: ["text"],
	supportsTools: true,
	contextWindow: 200_000,
	cost: { input: 1, output: 1 },
	reasoning: true,
	baseUrl: "https://api.anthropic.com",
} as unknown as Model<never>;

function registryFor(auth: AuthStorage): ModelRegistry {
	return {
		authStorage: auth,
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		getProviderBaseUrl: () => model.baseUrl as string,
	} as unknown as ModelRegistry;
}

const routingOverrides: Record<string, unknown> = {
	"task.routing.workerModels": ["anthropic/claude-sonnet-4-5"],
	"task.routing.enabled": true,
	"retry.usageReservePct": 10,
};

describe("PR #9108 review regressions", () => {
	it("keeps dynamic task routing opt-in by default", () => {
		expect(SETTINGS_SCHEMA["task.routing.enabled"].default).toBe(false);
	});

	describe("routing snapshot reads only broker in-memory cache passively (no fetch, no SQLite probe)", () => {
		afterEach(() => vi.restoreAllMocks());

		it("warm broker cache populates matching account headroom", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				accountId: "account-1",
			});
			const identity = auth.getOAuthAccountIdentity("anthropic", "test");
			const pool = resolveResourcePool({
				provider: "anthropic",
				baseUrl: model.baseUrl as string,
				accountId: identity?.accountId,
				email: identity?.email,
				credentialKind: auth.getCredentialOrigin("anthropic")?.kind,
			});
			const peek = vi
				.spyOn(
					auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
					"peekBrokerModelUsageHealth",
				)
				.mockReturnValue({
					state: "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							accountKey: "other",
							state: "depleted",
							remainingFraction: 0,
						},
						{
							credentialId: 2,
							credentialType: "oauth",
							accountKey: pool.accountKey,
							state: "healthy",
							remainingFraction: 0.82,
						},
					],
				});
			const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(peek).toHaveBeenCalled();
			expect(snapshot.candidates[0]?.usage).toBe("healthy");
			expect(snapshot.candidates[0]?.usageRemainingFraction).toBeCloseTo(0.82);
			auth.close();
		});

		it("cold broker cache resolves to unknown (no warm report)", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				accountId: "account-1",
			});
			const peek = vi
				.spyOn(
					auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
					"peekBrokerModelUsageHealth",
				)
				.mockReturnValue({
					state: "unknown",
					accounts: [{ credentialId: 1, credentialType: "oauth", accountKey: "account-1", state: "unknown" }],
				});
			const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(peek).toHaveBeenCalled();
			expect(snapshot.candidates[0]?.usage).toBe("unknown");
			expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
			auth.close();
		});

		it("expired broker cache (15s TTL) resolves to unknown", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				accountId: "account-1",
			});
			// RemoteAuthCredentialStore.peekCachedUsageReport returns null when Date.now - fetchedAt >= 15_000
			const peek = vi
				.spyOn(
					auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
					"peekBrokerModelUsageHealth",
				)
				.mockReturnValue({
					state: "unknown",
					accounts: [{ credentialId: 1, credentialType: "oauth", accountKey: "account-1", state: "unknown" }],
				});
			const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(peek).toHaveBeenCalled();
			expect(snapshot.candidates[0]?.usage).toBe("unknown");
			auth.close();
		});

		it("makes zero AuthBrokerClient.fetchUsage and zero provider quota calls", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				accountId: "account-1",
			});
			const peek = vi
				.spyOn(
					auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
					"peekBrokerModelUsageHealth",
				)
				.mockReturnValue({
					state: "healthy",
					accounts: [
						{
							credentialId: 1,
							credentialType: "oauth",
							accountKey: "account-1",
							state: "healthy",
							remainingFraction: 0.6,
						},
					],
				});
			const fetchSpy = vi.spyOn(auth, "fetchUsageReports" as never);
			const healthSpy = vi.spyOn(auth, "getModelUsageHealth");
			await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(peek).toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
			expect(healthSpy).not.toHaveBeenCalled();
			auth.close();
		});

		it("intentional single-account nonmatching fallback preserves warm fraction", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: Date.now() + 60_000,
				accountId: "candidate-account",
			});
			vi.spyOn(
				auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
				"peekBrokerModelUsageHealth",
			).mockReturnValue({
				state: "healthy",
				accounts: [
					{
						credentialId: 1,
						credentialType: "oauth",
						accountKey: "different-account",
						state: "healthy",
						remainingFraction: 0.71,
					},
				],
			});
			const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(snapshot.candidates[0]).toMatchObject({ usage: "healthy", usageRemainingFraction: 0.71 });
			auth.close();
		});

		it("ambiguous multi-account nonmatching stays unattributed (aggregate, no fraction)", async () => {
			const auth = await AuthStorage.create(":memory:");
			await auth.set("anthropic", { type: "api_key", key: "x", source: "login" });
			vi.spyOn(
				auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth },
				"peekBrokerModelUsageHealth",
			).mockReturnValue({
				state: "reserve",
				accounts: [
					{
						credentialId: 1,
						credentialType: "oauth",
						accountKey: "acct-a",
						state: "healthy",
						remainingFraction: 0.9,
					},
					{
						credentialId: 2,
						credentialType: "oauth",
						accountKey: "acct-b",
						state: "depleted",
						remainingFraction: 0,
					},
				],
			});
			const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
			expect(snapshot.candidates[0]?.pool.accountKey).toBe("api-key");
			expect(snapshot.candidates[0]?.usage).toBe("reserve");
			expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
			auth.close();
		});
	});

	it("keeps ledger persistence outside transcript discovery and uses static imports", async () => {
		const ledger = await readSource("task/subagent-ledger.ts");
		const executor = await readSource("task/executor.ts");
		expect(ledger).toContain(".ledger.ndjson");
		expect(ledger).not.toContain(".ledger.jsonl");
		expect(executor).not.toContain('await import("./subagent-ledger")');
		expect(executor).not.toContain('import("./subagent-ledger").LedgerEntry');
		expect(executor).toContain('logger.debug("Subagent ledger append failed"');
	});

	it("captures selected model before auth fallback", async () => {
		const source = await readSource("task/executor.ts");
		const selected = source.indexOf("const selectedResolution = resolveModelOverride(");
		const fallback = source.indexOf("resolveModelOverrideWithAuthFallback(");
		expect(selected).toBeGreaterThan(-1);
		expect(fallback).toBeGreaterThan(-1);
		expect(selected).toBeLessThan(fallback);
		expect(source).toContain("selectedResolution.explicitThinkingLevel");
	});

	it("does not persist sibling history before the batch failure gate", async () => {
		const source = await readSource("task/index.ts");
		const start = source.indexOf("const siblingPoolKeysForBatch");
		const failureGate = source.indexOf("if (preflightFailures.length > 0)", start);
		const beforeGate = source.slice(start, failureGate);
		expect(start).toBeGreaterThan(-1);
		expect(failureGate).toBeGreaterThan(start);
		expect(beforeGate).not.toContain("this.#siblingPoolKeys.push(poolKey)");
		expect(source.indexOf("this.#siblingPoolKeys.push(poolKey)", failureGate)).toBeGreaterThan(failureGate);
	});
});
