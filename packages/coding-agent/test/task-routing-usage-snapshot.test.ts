import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveResourcePool } from "@oh-my-pi/pi-coding-agent/task/routing/pool";
import { buildRoutingSnapshot } from "@oh-my-pi/pi-coding-agent/task/routing/snapshot";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function sessionWithRegistry(
	auth: AuthStorage,
	registry: ModelRegistry,
	overrides: Record<string, unknown>,
): ToolSession {
	const base = {
		modelRegistry: registry,
		authStorage: auth,
		getSessionId: () => "test",
		getActiveModelString: () => "anthropic/claude-opus-4-5",
		settings: Settings.isolated(overrides as never),
	} as unknown as ToolSession;
	return base;
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

describe("buildRoutingSnapshot usage attribution (broker cache peek)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("attributes warm broker cache matching account (healthy 0.8)", async () => {
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
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					accountKey: "other-account",
					state: "depleted",
					remainingFraction: 0,
				},
				{
					credentialId: 2,
					credentialType: "oauth",
					accountKey: pool.accountKey,
					state: "healthy",
					remainingFraction: 0.8,
				},
			],
		});
		const notCalled = vi.spyOn(auth, "getModelUsageHealth");
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(notCalled).not.toHaveBeenCalled();
		expect(snapshot.candidates).toHaveLength(1);
		expect(snapshot.candidates[0]?.pool.accountKey).toBe(pool.accountKey);
		expect(snapshot.candidates[0]?.usage).toBe("healthy");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBe(0.8);
		auth.close();
	});

	it("uses the sole health account as the intentional fallback when its key does not match (warm)", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			accountId: "candidate-account",
		});
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					accountKey: "different-account",
					state: "healthy",
					remainingFraction: 0.7,
				},
			],
		});
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(snapshot.candidates[0]).toMatchObject({ usage: "healthy", usageRemainingFraction: 0.7 });
		auth.close();
	});

	it("uses aggregate usage and omits remaining when two warm accounts miss an api-key pool (ambiguous)", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "api_key", key: "x", source: "login" });
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
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
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(snapshot.candidates[0]?.pool.accountKey).toBe("api-key");
		expect(snapshot.candidates[0]?.usage).toBe("reserve");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});

	it("resolves to unknown on cold broker cache (no warm report)", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000, accountId: "account-1" });
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
			state: "unknown",
			accounts: [{ credentialId: 1, credentialType: "oauth", accountKey: "account-1", state: "unknown" }],
		});
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(snapshot.candidates[0]?.usage).toBe("unknown");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});

	it("resolves to unknown when broker cache expired (stale 15s TTL)", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000, accountId: "account-1" });
		// Simulate expired: peek returns unknown (remote peek checks 15s TTL and returns null → unknown)
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
			state: "unknown",
			accounts: [{ credentialId: 1, credentialType: "oauth", accountKey: "account-1", state: "unknown" }],
		});
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(snapshot.candidates[0]?.usage).toBe("unknown");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});

	it("makes zero broker and provider fetches (peek only, no network)", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000, accountId: "account-1" });
		// Underline: peek path never touches usage providers; getModelUsageHealth must not be called
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockReturnValue({
			state: "healthy",
			accounts: [{ credentialId: 1, credentialType: "oauth", accountKey: "account-1", state: "healthy", remainingFraction: 0.6 }],
		});
		const fetchSpy = vi.spyOn(auth, "fetchUsageReports" as never);
		const healthSpy = vi.spyOn(auth, "getModelUsageHealth");
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		await buildRoutingSnapshot(session);
		await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(healthSpy).not.toHaveBeenCalled();
		auth.close();
	});

	it("fails open to unknown when peek throws", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "api_key", key: "x", source: "login" });
		const peek = vi.spyOn(auth as unknown as { peekBrokerModelUsageHealth: typeof auth.peekBrokerModelUsageHealth }, "peekBrokerModelUsageHealth").mockImplementation(() => {
			throw new Error("health unavailable");
		});
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expect(peek.mock.calls.length).toBeGreaterThan(0);
		expect(snapshot.candidates[0]?.usage).toBe("unknown");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});
});
