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
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides as Record<string, unknown>),
		getSessionId: () => "test",
		getActiveModelString: () => "anthropic/claude-sonnet-4-5",
		getModelString: () => "anthropic/claude-sonnet-4-5",
		taskDepth: 0,
		modelRegistry: registry,
		authStorage: auth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
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
		getAvailable: () => [model],
		hasConfiguredAuth: () => true,
		getProviderBaseUrl: () => model.baseUrl,
		authStorage: auth,
	} as unknown as ModelRegistry;
}

const routingOverrides: Record<string, unknown> = {
	"task.routing.workerModels": ["anthropic/claude-sonnet-4-5"],
	"task.routing.enabled": true,
	"retry.usageReservePct": 10,
};

function expectCachedOnly(health: ReturnType<typeof vi.spyOn>): void {
	expect(health.mock.calls.length).toBeGreaterThan(0);
	for (const [, options] of health.mock.calls) {
		expect(options?.cachedOnly).toBe(true);
	}
}

describe("buildRoutingSnapshot usage attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads persisted usage with cachedOnly and attributes a matching account", async () => {
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
		const health = vi.spyOn(auth, "getModelUsageHealth").mockResolvedValue({
			state: "depleted",
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
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expectCachedOnly(health);
		expect(snapshot.candidates).toHaveLength(1);
		expect(snapshot.candidates[0]?.pool.accountKey).toBe(pool.accountKey);
		expect(snapshot.candidates[0]?.usage).toBe("healthy");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBe(0.8);
		auth.close();
	});
	it("uses the sole health account as the intentional fallback when its key does not match", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", {
			type: "oauth",
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
			accountId: "candidate-account",
		});
		const health = vi.spyOn(auth, "getModelUsageHealth").mockResolvedValue({
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
		const snapshot = await buildRoutingSnapshot(sessionWithRegistry(auth, registryFor(auth), routingOverrides));
		expectCachedOnly(health);
		expect(snapshot.candidates[0]).toMatchObject({ usage: "healthy", usageRemainingFraction: 0.7 });
		auth.close();
	});

	it("uses aggregate usage and omits remaining when two accounts miss an api-key pool", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "api_key", key: "x", source: "login" });
		const health = vi.spyOn(auth, "getModelUsageHealth").mockResolvedValue({
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
		expectCachedOnly(health);
		expect(snapshot.candidates[0]?.pool.accountKey).toBe("api-key");
		expect(snapshot.candidates[0]?.usage).toBe("reserve");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});

	it("fails open to unknown when getModelUsageHealth throws", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("anthropic", { type: "api_key", key: "x", source: "login" });
		const health = vi.spyOn(auth, "getModelUsageHealth").mockRejectedValue(new Error("health unavailable"));
		const session = sessionWithRegistry(auth, registryFor(auth), routingOverrides);
		const snapshot = await buildRoutingSnapshot(session);
		expectCachedOnly(health);
		expect(snapshot.candidates[0]?.usage).toBe("unknown");
		expect(snapshot.candidates[0]?.usageRemainingFraction).toBeUndefined();
		auth.close();
	});
});
