import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { Model } from "@oh-my-pi/pi-catalog";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { filterRoutingCandidates } from "../src/task/routing/candidates";
import { resolveResourcePool } from "../src/task/routing/pool";
import { routeWorker } from "../src/task/routing/router";
import { scoreRoutingCandidate } from "../src/task/routing/select";
import { buildRoutingSnapshot } from "../src/task/routing/snapshot";
import type {
	ResourcePoolIdentity,
	RoutingCandidateInput,
	RoutingPolicy,
	RoutingRequest,
} from "../src/task/routing/types";
import type { ToolSession } from "../src/tools";

function pool(
	provider: string,
	opts: { baseUrl?: string; accountId?: string; email?: string; credentialKind?: string } = {},
): ResourcePoolIdentity {
	return resolveResourcePool({ provider, ...opts });
}

function candidate(
	overrides: Partial<RoutingCandidateInput> & { selector: string; pool: ResourcePoolIdentity },
): RoutingCandidateInput {
	return {
		vision: false,
		supportsTools: true,
		contextWindow: 200_000,
		costPerMTokenTotal: 10,
		reasoning: false,
		usage: "healthy",
		...overrides,
	};
}

function basePolicy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
	return {
		enabled: true,
		avoidParentPool: true,
		parentPoolFallback: "allow",
		excludePools: [],
		preferPools: [],
		...overrides,
	};
}

function request(
	overrides: Partial<RoutingRequest> & { candidates: readonly RoutingCandidateInput[] },
): RoutingRequest {
	return {
		agent: "sonic",
		intent: "cheap",
		requirements: {},
		policy: basePolicy(),
		random: () => 0,
		...overrides,
	} as RoutingRequest;
}

const cheapPoolA = pool("google-antigravity", { baseUrl: "https://agy.example" });
const cheapPoolB = pool("cerebras", { baseUrl: "https://cerebras.example" });
const expensivePoolX = pool("cursor", { baseUrl: "https://api.cursor.com" });

function cheapA(extra: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
	return candidate({
		selector: "google-antigravity/gemini-3.1-flash-lite",
		pool: cheapPoolA,
		cheap: true,
		costPerMTokenTotal: 0.2,
		usage: "unknown",
		...extra,
	});
}

function cheapB(extra: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
	return candidate({
		selector: "cerebras/zai-glm-4.7",
		pool: cheapPoolB,
		cheap: true,
		costPerMTokenTotal: 0.4,
		usage: "healthy",
		usageRemainingFraction: 0.15,
		...extra,
	});
}

function expensiveX(extra: Partial<RoutingCandidateInput> = {}): RoutingCandidateInput {
	return candidate({
		selector: "cursor/cursor-grok-4.6",
		pool: expensivePoolX,
		cheap: false,
		vision: true,
		supportsTools: true,
		reasoning: true,
		costPerMTokenTotal: 80,
		usage: "healthy",
		usageRemainingFraction: 1,
		preferredRank: 0,
		...extra,
	});
}

function adversarialCandidates(): RoutingCandidateInput[] {
	return [cheapA(), cheapB(), expensiveX()];
}

function adversarialRequest(extra: Partial<RoutingRequest> = {}): RoutingRequest {
	return request({
		candidates: adversarialCandidates(),
		policy: basePolicy({ preferPools: ["cursor"] }),
		...extra,
	});
}

describe("cheap eligibility contract", () => {
	it("excludes a non-cheap perfect-headroom candidate before scoring (adversarial)", () => {
		const req = adversarialRequest();
		const xScore = scoreRoutingCandidate(expensiveX(), req);
		const aScore = scoreRoutingCandidate(cheapA(), req);
		const bScore = scoreRoutingCandidate(cheapB(), req);
		expect(xScore).toBeGreaterThan(bScore);
		expect(xScore).toBeGreaterThan(aScore);

		const filtered = filterRoutingCandidates(req);
		expect(filtered.viable.map(c => c.selector)).not.toContain("cursor/cursor-grok-4.6");
		expect(filtered.viable.map(c => c.selector).sort()).toEqual([
			"cerebras/zai-glm-4.7",
			"google-antigravity/gemini-3.1-flash-lite",
		]);
		expect(filtered.trace).toContain("cheap eligibility removed 1 candidate(s)");

		const outcome = routeWorker(req);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors).not.toContain("cursor/cursor-grok-4.6");
		expect(outcome.selectors[0]).toBe("cerebras/zai-glm-4.7");
		expect(outcome.trace).toContain("cheap eligibility removed 1 candidate(s)");
	});

	it("keeps dynamic choice, headroom, diversity, and parent anti-affinity inside the cheap set", () => {
		const healthyA = cheapA({ usage: "healthy", usageRemainingFraction: 1, costPerMTokenTotal: 0.4 });
		const reserveB = cheapB({ usage: "reserve", usageRemainingFraction: 1, costPerMTokenTotal: 0.1 });
		const headroom = routeWorker(
			request({
				candidates: [healthyA, reserveB, expensiveX()],
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(headroom.ok).toBe(true);
		if (!headroom.ok) return;
		expect(headroom.selectors[0]).toBe(healthyA.selector);
		expect(headroom.usageInfluenced).toBe(true);

		const equalCheap = [
			cheapA({ usage: "healthy", usageRemainingFraction: 0.5, costPerMTokenTotal: 0.3 }),
			cheapB({ usage: "healthy", usageRemainingFraction: 0.5, costPerMTokenTotal: 0.3 }),
		];
		const diversified = routeWorker(
			request({
				candidates: [...equalCheap, expensiveX()],
				siblingPools: [cheapPoolA.key],
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(diversified.ok).toBe(true);
		if (!diversified.ok) return;
		expect(diversified.selectors[0]).toBe(cheapB().selector);
		expect(diversified.selectors).not.toContain(expensiveX().selector);

		const parent = cheapPoolA;
		const anti = routeWorker(
			request({
				parentPool: parent,
				candidates: [
					cheapA({ usage: "healthy", usageRemainingFraction: 1 }),
					cheapB({ usage: "unknown" }),
					expensiveX(),
				],
				policy: basePolicy({ avoidParentPool: true, preferPools: ["cursor"] }),
			}),
		);
		expect(anti.ok).toBe(true);
		if (!anti.ok) return;
		expect(anti.antiAffinityApplied).toBe(true);
		expect(anti.pool.key).toBe(cheapPoolB.key);
		expect(anti.selectors[0]).toBe(cheapB().selector);
	});

	it("returns no_viable_candidate when no cheap-eligible model remains", () => {
		const outcome = routeWorker(
			request({
				candidates: [
					expensiveX(),
					candidate({
						selector: "openai-codex/gpt-5.5",
						pool: pool("openai-codex", { baseUrl: "https://api.openai.com" }),
						cheap: false,
						reasoning: true,
						costPerMTokenTotal: 20,
						usage: "healthy",
						usageRemainingFraction: 1,
						preferredRank: 0,
					}),
				],
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("no_viable_candidate");
		expect(outcome.trace.some(line => line.startsWith("cheap eligibility removed"))).toBe(true);
	});

	it("leaves strong, default, and normal free to select the premium candidate", () => {
		for (const intent of ["default", "normal"] as const) {
			const outcome = routeWorker(adversarialRequest({ intent }));
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.selectors[0]).toBe("cursor/cursor-grok-4.6");
			expect(outcome.trace.some(line => line.startsWith("cheap eligibility removed"))).toBe(false);
		}

		const strong = routeWorker(adversarialRequest({ intent: "strong" }));
		expect(strong.ok).toBe(true);
		if (!strong.ok) return;
		expect(strong.selectors[0]).toBe("cursor/cursor-grok-4.6");
		expect(strong.trace.some(line => line.includes("strong intent removed"))).toBe(true);
	});

	it("composes cheap eligibility with vision, large-context, and structured-output requirements", () => {
		const cheapVision = cheapA({
			vision: true,
			contextWindow: 1_000_000,
			supportsTools: true,
			usage: "unknown",
		});
		const cheapBlind = cheapB({
			vision: false,
			contextWindow: 8_000,
			supportsTools: false,
			usage: "healthy",
			usageRemainingFraction: 1,
		});
		const expensiveVision = expensiveX({ contextWindow: 1_000_000, supportsTools: true });

		const vision = routeWorker(
			request({
				candidates: [cheapVision, cheapBlind, expensiveVision],
				requirements: { vision: true },
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(vision.ok).toBe(true);
		if (!vision.ok) return;
		expect(vision.selectors[0]).toBe(cheapVision.selector);
		expect(vision.selectors).not.toContain(expensiveVision.selector);

		const largeContext = routeWorker(
			request({
				intent: "large-context",
				candidates: [cheapVision, cheapBlind, expensiveVision],
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(largeContext.ok).toBe(true);
		if (!largeContext.ok) return;
		expect(largeContext.selectors).toContain(expensiveVision.selector);

		const cheapLarge = routeWorker(
			request({
				candidates: [cheapVision, cheapBlind, expensiveVision],
				requirements: { minContextWindow: 200_000 },
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(cheapLarge.ok).toBe(true);
		if (!cheapLarge.ok) return;
		expect(cheapLarge.selectors[0]).toBe(cheapVision.selector);
		expect(cheapLarge.selectors).not.toContain(expensiveVision.selector);

		const structured = routeWorker(
			request({
				candidates: [cheapVision, cheapBlind, expensiveVision],
				requirements: { structuredOutput: true },
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(structured.ok).toBe(true);
		if (!structured.ok) return;
		expect(structured.selectors[0]).toBe(cheapVision.selector);
		expect(structured.selectors).not.toContain(expensiveVision.selector);
	});

	it("still hard-filters depleted cheap models and keeps unknown cheap models", () => {
		const depletedCheap = cheapA({ usage: "depleted", usageRemainingFraction: 1 });
		const unknownCheap = cheapB({ usage: "unknown" });
		const outcome = routeWorker(
			request({
				candidates: [depletedCheap, unknownCheap, expensiveX()],
				policy: basePolicy({ preferPools: ["cursor"] }),
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors).not.toContain(depletedCheap.selector);
		expect(outcome.selectors).not.toContain(expensiveX().selector);
		expect(outcome.selectors[0]).toBe(unknownCheap.selector);
	});
});

function fakeModel(opts: {
	provider: string;
	id: string;
	baseUrl: string;
	cost?: number;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	supportsTools?: boolean;
}): Model<never> {
	return {
		provider: opts.provider,
		id: opts.id,
		input: opts.input ?? ["text"],
		supportsTools: opts.supportsTools ?? true,
		contextWindow: opts.contextWindow ?? 200_000,
		cost: { input: opts.cost ?? 0.1, output: opts.cost ?? 0.1 },
		reasoning: opts.reasoning ?? false,
		baseUrl: opts.baseUrl,
	} as unknown as Model<never>;
}

function sessionWithRegistry(
	auth: AuthStorage,
	registry: ModelRegistry,
	overrides: Record<string, unknown>,
	active = "anthropic/claude-sonnet-4-5",
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(overrides as Record<string, unknown>),
		getSessionId: () => "test",
		getActiveModelString: () => active,
		getModelString: () => active,
		taskDepth: 0,
		modelRegistry: registry,
		authStorage: auth,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("cheap eligibility from candidate building", () => {
	it("tags @smol-class models cheap while leaving premium roster members visible but ineligible", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("google-antigravity", { type: "api_key", key: "agy" });
		await auth.set("cerebras", { type: "api_key", key: "cerebras" });
		await auth.set("openai-codex", { type: "api_key", key: "codex" });
		await auth.set("cursor", { type: "api_key", key: "cursor" });

		const flashLite = fakeModel({
			provider: "google-antigravity",
			id: "gemini-3.1-flash-lite",
			baseUrl: "https://agy.example",
			cost: 0.05,
		});
		const glm = fakeModel({
			provider: "cerebras",
			id: "zai-glm-4.7",
			baseUrl: "https://cerebras.example",
			cost: 0.1,
		});
		const gpt = fakeModel({
			provider: "openai-codex",
			id: "gpt-5.5",
			baseUrl: "https://api.openai.com",
			cost: 15,
			reasoning: true,
		});
		const grok = fakeModel({
			provider: "cursor",
			id: "cursor-grok-4.6",
			baseUrl: "https://api.cursor.com",
			cost: 20,
			reasoning: true,
			input: ["text", "image"],
		});
		const available = [flashLite, glm, gpt, grok];
		const registry = {
			getAvailable: () => available,
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: (provider: string) => available.find(model => model.provider === provider)?.baseUrl,
			authStorage: auth,
		} as unknown as ModelRegistry;

		(
			auth as unknown as {
				peekBrokerModelUsageHealth: (provider: string, opts: { modelId: string }) => unknown;
			}
		).peekBrokerModelUsageHealth = (_provider, opts) => {
			if (opts.modelId === "cursor-grok-4.6") {
				return {
					state: "healthy",
					accounts: [{ accountKey: "api-key", state: "healthy", remainingFraction: 1 }],
				};
			}
			return { state: "unknown", accounts: [] };
		};

		const session = sessionWithRegistry(auth, registry, {
			"task.routing.workerModels": [
				"google-antigravity/gemini-3.1-flash-lite",
				"cerebras/zai-glm-4.7",
				"openai-codex/gpt-5.5",
				"cursor/cursor-grok-4.6",
			],
			"task.routing.enabled": true,
			"task.routing.avoidParentPool": false,
			"task.routing.parentPoolFallback": "allow",
			"task.routing.excludePools": [] as string[],
			"task.routing.preferPools": ["cursor"] as string[],
			"retry.usageReservePct": 10,
			modelRoles: { smol: "cerebras/zai-glm-4.7" },
		});

		const snap = await buildRoutingSnapshot(session);
		const bySelector = new Map(snap.candidates.map(c => [c.selector, c]));
		expect(bySelector.size).toBe(4);
		expect(bySelector.get("google-antigravity/gemini-3.1-flash-lite")?.cheap).toBe(true);
		expect(bySelector.get("cerebras/zai-glm-4.7")?.cheap).toBe(true);
		expect(bySelector.get("openai-codex/gpt-5.5")?.cheap).toBe(false);
		expect(bySelector.get("cursor/cursor-grok-4.6")?.cheap).toBe(false);
		expect(bySelector.get("cursor/cursor-grok-4.6")?.usage).toBe("healthy");
		expect(bySelector.get("cursor/cursor-grok-4.6")?.usageRemainingFraction).toBe(1);

		const outcome = routeWorker(
			request({
				candidates: snap.candidates,
				policy: basePolicy({ avoidParentPool: false, preferPools: ["cursor"] }),
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors).not.toContain("cursor/cursor-grok-4.6");
		expect(outcome.selectors).not.toContain("openai-codex/gpt-5.5");
		expect(["google-antigravity/gemini-3.1-flash-lite", "cerebras/zai-glm-4.7"]).toContain(outcome.selectors[0]);
		expect(outcome.trace).toContain("cheap eligibility removed 2 candidate(s)");
		auth.close();
	});

	it("treats a configured modelRoles.smol selector as cheap even when it is outside priority.json", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.set("meta", { type: "api_key", key: "meta" });
		await auth.set("cursor", { type: "api_key", key: "cursor" });
		const muse = fakeModel({
			provider: "meta",
			id: "muse-spark-1.2-contributor",
			baseUrl: "https://meta.example",
			cost: 0,
			reasoning: true,
		});
		const grok = fakeModel({
			provider: "cursor",
			id: "cursor-grok-4.6",
			baseUrl: "https://api.cursor.com",
			cost: 20,
			reasoning: true,
		});
		const available = [muse, grok];
		const registry = {
			getAvailable: () => available,
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: (provider: string) => available.find(model => model.provider === provider)?.baseUrl,
			authStorage: auth,
		} as unknown as ModelRegistry;
		const session = sessionWithRegistry(auth, registry, {
			"task.routing.workerModels": ["meta/muse-spark-1.2-contributor", "cursor/cursor-grok-4.6"],
			"task.routing.enabled": true,
			modelRoles: { smol: "meta/muse-spark-1.2-contributor" },
			"retry.usageReservePct": 10,
		});
		const snap = await buildRoutingSnapshot(session);
		expect(snap.candidates.find(c => c.selector === "meta/muse-spark-1.2-contributor")?.cheap).toBe(true);
		expect(snap.candidates.find(c => c.selector === "cursor/cursor-grok-4.6")?.cheap).toBe(false);
		auth.close();
	});
});
