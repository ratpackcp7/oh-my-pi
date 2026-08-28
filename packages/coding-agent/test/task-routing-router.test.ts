import { describe, expect, it } from "bun:test";
import { resolveResourcePool } from "../src/task/routing/pool";
import { routeWorker } from "../src/task/routing/router";
import { seededRandom, usageScoreComponent } from "../src/task/routing/select";
import type {
	ResourcePoolIdentity,
	RoutingCandidateInput,
	RoutingPolicy,
	RoutingRequest,
} from "../src/task/routing/types";

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
		agent: "task",
		intent: "default",
		requirements: {},
		policy: basePolicy(),
		random: () => 0,
		...overrides,
	} as RoutingRequest;
}

describe("task routing router", () => {
	it("F1 parent anthropic direct avoids parent pool when alternatives exist", () => {
		const parent = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const anthropicPool = parent;
		const cursorPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const agyPool = pool("google", { baseUrl: "https://agy.example.com" });
		const codexPool = pool("codex", { baseUrl: "https://api.openai.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/claude-sonnet-4", pool: anthropicPool }),
			candidate({ selector: "cursor/composer-2.5", pool: cursorPool }),
			candidate({ selector: "google/gemini-2.5", pool: agyPool }),
			candidate({ selector: "codex/gpt-5", pool: codexPool }),
		];

		const outcome = routeWorker(request({ parentPool: parent, candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.pool.key).not.toBe(parent.key);
		expect(outcome.antiAffinityApplied).toBe(true);
		expect(outcome.selectors[0]).not.toBe("anthropic/claude-sonnet-4");
	});

	it("F2 parent codex avoids codex pool when alternatives exist", () => {
		const parent = pool("codex", { baseUrl: "https://api.openai.com" });
		const codexPool = parent;
		const anthropicPool = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const cursorPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const agyPool = pool("google", { baseUrl: "https://agy.example.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/gpt-5", pool: codexPool }),
			candidate({ selector: "anthropic/claude-sonnet-4", pool: anthropicPool }),
			candidate({ selector: "cursor/composer-2.5", pool: cursorPool }),
			candidate({ selector: "google/gemini-2.5", pool: agyPool }),
		];

		const outcome = routeWorker(request({ parentPool: parent, candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.pool.key).not.toBe(parent.key);
		expect(outcome.antiAffinityApplied).toBe(true);
	});

	it("F3 cursor Claude pool is distinct from direct Anthropic and account/env semantics hold", () => {
		const anthropicDirect = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const cursorClaude = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		// different provider+baseUrl => distinct keys
		expect(cursorClaude.key).not.toBe(anthropicDirect.key);

		// same provider with two different account keys yields distinct pools
		const alice = pool("anthropic", { baseUrl: "https://api.anthropic.com", accountId: "alice@x.com" });
		const bob = pool("anthropic", { baseUrl: "https://api.anthropic.com", accountId: "bob@x.com" });
		expect(alice.key).not.toBe(bob.key);
		expect(alice.label).toBe("anthropic (alice@x.com)");
		expect(bob.label).toBe("anthropic (bob@x.com)");

		// env-derived credentials collapse to one shared pool per provider+baseUrl
		const env1 = pool("openai", { baseUrl: "https://api.openai.com", credentialKind: "env" });
		const env2 = pool("openai", { baseUrl: "https://api.openai.com", credentialKind: "env" });
		const env3 = pool("openai", { baseUrl: "https://api.openai.com" }); // no credentialKind => "none" => different from env
		expect(env1.key).toBe(env2.key);
		expect(env1.key).not.toBe(env3.key);
		expect(env1.accountKey).toBe("env");

		// cursor pool is selectable when parent is Anthropic direct (anti-affinity allows non-parent)
		const parent = anthropicDirect;
		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/claude-sonnet-4", pool: anthropicDirect }),
			candidate({ selector: "cursor/claude-sonnet-4", pool: cursorClaude }),
		];
		const outcome = routeWorker(request({ parentPool: parent, candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// with anti-affinity, cursor must be chosen
		expect(outcome.pool.key).toBe(cursorClaude.key);
	});

	it("F4 excludePools codex removes codex candidates and reports pattern", () => {
		const anthropicPool = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const codexPool = pool("codex", { baseUrl: "https://api.openai.com" });
		const cursorPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/gpt-5", pool: codexPool, costPerMTokenTotal: 1 }),
			candidate({ selector: "cursor/composer-2.5", pool: cursorPool, costPerMTokenTotal: 50 }),
			candidate({ selector: "anthropic/claude-sonnet-4", pool: anthropicPool, costPerMTokenTotal: 50 }),
		];

		const outcome = routeWorker(
			request({
				candidates,
				policy: basePolicy({ excludePools: ["codex"] }),
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors.every(s => !s.includes("codex"))).toBe(true);
		expect(outcome.exclusionsApplied).toContain("codex");
		// no selector should be codex-pool
		expect(outcome.pool.provider).not.toBe("codex");
	});

	it("F5 healthy beats reserve and usageInfluenced is true", () => {
		const healthyPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const reservePool = pool("codex", { baseUrl: "https://api.openai.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/gpt-5", pool: reservePool, usage: "reserve", costPerMTokenTotal: 1 }),
			candidate({ selector: "cursor/composer-2.5", pool: healthyPool, usage: "healthy", costPerMTokenTotal: 50 }),
		];

		const outcome = routeWorker(request({ candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.pool.key).toBe(healthyPool.key);
		expect(outcome.selectors[0]).toBe("cursor/composer-2.5");
		expect(outcome.usageInfluenced).toBe(true);
	});

	it("F6 unknown is viable, ranks below healthy but above reserve, and never bypasses exclusion or anti-affinity", () => {
		const pA = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const pB = pool("codex", { baseUrl: "https://api.openai.com" });
		const pC = pool("anthropic", { baseUrl: "https://api.anthropic.com" });

		// ranking check: healthy > unknown > reserve when otherwise equal
		const rankingCandidates: RoutingCandidateInput[] = [
			candidate({ selector: "a/reserve", pool: pA, usage: "reserve" }),
			candidate({ selector: "b/unknown", pool: pB, usage: "unknown" }),
			candidate({ selector: "c/healthy", pool: pC, usage: "healthy" }),
		];
		const rankingOutcome = routeWorker(request({ candidates: rankingCandidates }));
		expect(rankingOutcome.ok).toBe(true);
		if (!rankingOutcome.ok) return;
		expect(rankingOutcome.selectors[0]).toBe("c/healthy");
		// unknown should be second, reserve last — verify ordering via selectors
		expect(rankingOutcome.selectors[1]).toBe("b/unknown");
		expect(rankingOutcome.selectors[2]).toBe("a/reserve");

		// unknown does NOT bypass exclusion
		const excludedUnknown: RoutingCandidateInput[] = [
			candidate({ selector: "codex/unknown", pool: pB, usage: "unknown" }),
			candidate({ selector: "cursor/healthy", pool: pA, usage: "healthy" }),
		];
		const exclOutcome = routeWorker(
			request({
				candidates: excludedUnknown,
				policy: basePolicy({ excludePools: ["codex"] }),
			}),
		);
		expect(exclOutcome.ok).toBe(true);
		if (!exclOutcome.ok) return;
		expect(exclOutcome.selectors.every(s => !s.includes("codex"))).toBe(true);
		expect(exclOutcome.exclusionsApplied).toContain("codex");

		// unknown does NOT bypass parent-pool anti-affinity
		const parent = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const parentUnknown: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/unknown", pool: parent, usage: "unknown" }),
			candidate({ selector: "cursor/healthy", pool: pA, usage: "healthy" }),
		];
		const affinityOutcome = routeWorker(request({ parentPool: parent, candidates: parentUnknown }));
		expect(affinityOutcome.ok).toBe(true);
		if (!affinityOutcome.ok) return;
		expect(affinityOutcome.pool.key).not.toBe(parent.key);
		expect(affinityOutcome.antiAffinityApplied).toBe(true);
	});

	it("F7 vision requirement filters non-vision cheaper candidate", () => {
		const visionPool = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const nonVisionPool = pool("codex", { baseUrl: "https://api.openai.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/cheap", pool: nonVisionPool, vision: false, costPerMTokenTotal: 1 }),
			candidate({ selector: "anthropic/vision", pool: visionPool, vision: true, costPerMTokenTotal: 50 }),
		];

		const byRequirement = routeWorker(request({ candidates, requirements: { vision: true } }));
		expect(byRequirement.ok).toBe(true);
		if (!byRequirement.ok) return;
		expect(byRequirement.selectors[0]).toBe("anthropic/vision");

		const byIntent = routeWorker(request({ candidates, intent: "vision" }));
		expect(byIntent.ok).toBe(true);
		if (!byIntent.ok) return;
		expect(byIntent.selectors[0]).toBe("anthropic/vision");
	});

	it("F8 strong intent never ranks non-reasoning above reasoning", () => {
		const cheapPool = pool("codex", { baseUrl: "https://api.openai.com" });
		const strongPool = pool("anthropic", { baseUrl: "https://api.anthropic.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/cheap", pool: cheapPool, reasoning: false, costPerMTokenTotal: 1 }),
			candidate({ selector: "anthropic/strong", pool: strongPool, reasoning: true, costPerMTokenTotal: 100 }),
		];

		const outcome = routeWorker(request({ candidates, intent: "strong" }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors[0]).toBe("anthropic/strong");
		expect(outcome.pool.key).toBe(strongPool.key);
	});

	it("F10 parentPoolFallback allow uses parent pool and reason mentions exception", () => {
		const parent = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		// only parent-pool candidates remain after exclusion removes external
		const codexPool = pool("codex", { baseUrl: "https://api.openai.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/claude", pool: parent }),
			candidate({ selector: "codex/gpt-5", pool: codexPool }),
		];

		const outcome = routeWorker(
			request({
				parentPool: parent,
				candidates,
				policy: basePolicy({ excludePools: ["codex"], parentPoolFallback: "allow" }),
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.pool.key).toBe(parent.key);
		expect(outcome.parentPoolFallback).toBe(true);
		expect(outcome.reason.toLowerCase()).toMatch(/fallback|exception/);
	});

	it("F11 parentPoolFallback deny returns parent_pool_fail_closed", () => {
		const parent = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const codexPool = pool("codex", { baseUrl: "https://api.openai.com" });

		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/claude", pool: parent }),
			candidate({ selector: "codex/gpt-5", pool: codexPool }),
		];

		const outcome = routeWorker(
			request({
				parentPool: parent,
				candidates,
				policy: basePolicy({ excludePools: ["codex"], parentPoolFallback: "deny" }),
			}),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("parent_pool_fail_closed");
	});

	it("F13 sibling diversity spreads across pools over successive calls", () => {
		const poolA = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const poolB = pool("codex", { baseUrl: "https://api.openai.com" });
		const poolC = pool("anthropic", { baseUrl: "https://api.anthropic.com" });

		const baseCandidates: RoutingCandidateInput[] = [
			candidate({ selector: "cursor/a", pool: poolA }),
			candidate({ selector: "codex/b", pool: poolB }),
			candidate({ selector: "anthropic/c", pool: poolC }),
		];

		const picked: string[] = [];
		let siblingPools: string[] = [];
		for (let i = 0; i < 3; i++) {
			const outcome = routeWorker(request({ candidates: baseCandidates, siblingPools }));
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			picked.push(outcome.pool.key);
			siblingPools = [...siblingPools, outcome.pool.key];
		}

		const distinct = new Set(picked);
		expect(distinct.size).toBeGreaterThan(1);
	});

	it("routing_disabled when policy.enabled is false", () => {
		const p = pool("cursor");
		const outcome = routeWorker(
			request({
				candidates: [candidate({ selector: "cursor/a", pool: p })],
				policy: basePolicy({ enabled: false }),
			}),
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("routing_disabled");
	});

	it("no_viable_candidate when empty", () => {
		const outcome = routeWorker(request({ candidates: [] }));
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.code).toBe("no_viable_candidate");
	});

	it("selectors are deduped and ordered best-first", () => {
		const pHealthy = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const pReserve = pool("codex", { baseUrl: "https://api.openai.com" });

		// duplicate selector appears twice (different pool instance but same selector string) — dedup keeps highest-scored first
		const dupSelector = "cursor/composer-2.5";
		const candidates: RoutingCandidateInput[] = [
			// reserve version of same selector (lower score) listed first
			candidate({ selector: dupSelector, pool: pReserve, usage: "reserve", costPerMTokenTotal: 1 }),
			candidate({ selector: dupSelector, pool: pHealthy, usage: "healthy", costPerMTokenTotal: 50 }),
			candidate({ selector: "codex/gpt-5", pool: pReserve, usage: "reserve" }),
		];

		const outcome = routeWorker(request({ candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		// deduped: only one occurrence of dupSelector
		expect(outcome.selectors.filter(s => s === dupSelector).length).toBe(1);
		// ordered best-first: healthy dup should be first (healthy > reserve)
		expect(outcome.selectors[0]).toBe(dupSelector);
		expect(outcome.selectors.length).toBe(2);
	});

	it("F8 strong intent survives compound bonuses on a weaker candidate", () => {
		// The non-reasoning candidate stacks every advantage the scorer offers:
		// healthy usage, a preferPools match, and the agent's configured default.
		// The reasoning candidate stacks every penalty short of exclusion.
		const cheapPool = pool("cheapo");
		const strongPool = pool("bigbrain");
		const outcome = routeWorker(
			request({
				intent: "strong",
				policy: basePolicy({ preferPools: ["cheapo"] }),
				siblingPools: [strongPool.key],
				candidates: [
					candidate({
						selector: "cheapo/tiny",
						pool: cheapPool,
						reasoning: false,
						usage: "healthy",
						costPerMTokenTotal: 0,
						preferredRank: 0,
					}),
					candidate({
						selector: "bigbrain/thinker",
						pool: strongPool,
						reasoning: true,
						usage: "reserve",
						costPerMTokenTotal: 40,
					}),
				],
			}),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors[0]).toBe("bigbrain/thinker");
		expect(outcome.selectors).not.toContain("cheapo/tiny");
	});

	it("headroom: healthy 0.9 beats 0.1 when otherwise equal", () => {
		const poolHigh = pool("anthropic", { accountId: "high@x.com" });
		const poolLow = pool("anthropic", { accountId: "low@x.com" });
		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/low", pool: poolLow, usage: "healthy", usageRemainingFraction: 0.1 }),
			candidate({ selector: "anthropic/high", pool: poolHigh, usage: "healthy", usageRemainingFraction: 0.9 }),
		];
		const outcome = routeWorker(request({ candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors[0]).toBe("anthropic/high");
		expect(outcome.pool.key).toBe(poolHigh.key);
	});

	it("headroom does not beat sibling diversity: 0.1 wins when 0.9 pool is a sibling", () => {
		const poolHigh = pool("anthropic", { accountId: "high@x.com" });
		const poolLow = pool("anthropic", { accountId: "low@x.com" });
		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "anthropic/low", pool: poolLow, usage: "healthy", usageRemainingFraction: 0.1 }),
			candidate({ selector: "anthropic/high", pool: poolHigh, usage: "healthy", usageRemainingFraction: 0.9 }),
		];
		const outcome = routeWorker(request({ candidates, siblingPools: [poolHigh.key] }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors[0]).toBe("anthropic/low");
		expect(outcome.pool.key).toBe(poolLow.key);
	});

	it("reserve with fraction 1 never outranks healthy with fraction 0", () => {
		const healthyPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const reservePool = pool("codex", { baseUrl: "https://api.openai.com" });
		// equal cost — pure usage/headroom contest: healthy 30+0 vs reserve -40 => 70pt gap
		const candidates: RoutingCandidateInput[] = [
			candidate({ selector: "codex/reserve", pool: reservePool, usage: "reserve", usageRemainingFraction: 1 }),
			candidate({ selector: "cursor/healthy", pool: healthyPool, usage: "healthy", usageRemainingFraction: 0 }),
		];
		const outcome = routeWorker(request({ candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors[0]).toBe("cursor/healthy");
		expect(outcome.pool.key).toBe(healthyPool.key);
		// reversed input order still picks healthy
		const reversed = routeWorker(request({ candidates: [...candidates].reverse() }));
		expect(reversed.ok).toBe(true);
		if (!reversed.ok) return;
		expect(reversed.selectors[0]).toBe("cursor/healthy");
		// even when reserve is cheapest and healthy is most expensive, healthy still wins
		const cheapReserveVsExpensiveHealthy = routeWorker(
			request({
				candidates: [
					candidate({
						selector: "codex/reserve",
						pool: reservePool,
						usage: "reserve",
						usageRemainingFraction: 1,
						costPerMTokenTotal: 0,
					}),
					candidate({
						selector: "cursor/healthy",
						pool: healthyPool,
						usage: "healthy",
						usageRemainingFraction: 0,
						costPerMTokenTotal: 100,
					}),
				],
			}),
		);
		expect(cheapReserveVsExpensiveHealthy.ok).toBe(true);
		if (!cheapReserveVsExpensiveHealthy.ok) return;
		expect(cheapReserveVsExpensiveHealthy.selectors[0]).toBe("cursor/healthy");
	});

	it("depleted with fraction 1 is hard-filtered", () => {
		const depletedPool = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
		const healthyPool = pool("cursor", { baseUrl: "https://api.cursor.sh" });
		const reservePool = pool("codex", { baseUrl: "https://api.openai.com" });
		const candidates: RoutingCandidateInput[] = [
			candidate({
				selector: "anthropic/depleted",
				pool: depletedPool,
				usage: "depleted",
				usageRemainingFraction: 1,
			}),
			candidate({ selector: "cursor/healthy", pool: healthyPool, usage: "healthy", usageRemainingFraction: 0 }),
		];
		const outcome = routeWorker(request({ candidates }));
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.selectors).not.toContain("anthropic/depleted");
		expect(outcome.selectors[0]).toBe("cursor/healthy");
		expect(outcome.pool.key).toBe(healthyPool.key);
		// depleted alone yields no_viable_candidate
		const alone = routeWorker(
			request({
				candidates: [
					candidate({
						selector: "anthropic/depleted",
						pool: depletedPool,
						usage: "depleted",
						usageRemainingFraction: 1,
					}),
				],
			}),
		);
		expect(alone.ok).toBe(false);
		if (alone.ok) return;
		expect(alone.code).toBe("no_viable_candidate");
		// depleted is filtered even when the only alternative is reserve (reserve stays, depleted leaves)
		const vsReserve = routeWorker(
			request({
				candidates: [
					candidate({
						selector: "anthropic/depleted",
						pool: depletedPool,
						usage: "depleted",
						usageRemainingFraction: 1,
					}),
					candidate({ selector: "codex/reserve", pool: reservePool, usage: "reserve", usageRemainingFraction: 1 }),
				],
			}),
		);
		expect(vsReserve.ok).toBe(true);
		if (!vsReserve.ok) return;
		expect(vsReserve.selectors).not.toContain("anthropic/depleted");
		expect(vsReserve.selectors[0]).toBe("codex/reserve");
	});

	it("bounded tie-break is stable for a given seed and varies across seeds", () => {
		const pools = ["alpha", "beta", "gamma"].map(name => pool(name));
		const candidates = pools.map((identity, index) =>
			candidate({ selector: `${identity.provider}/model`, pool: identity, costPerMTokenTotal: 10 + index * 0.1 }),
		);
		const pick = (seed: string): string | undefined => {
			const outcome = routeWorker(request({ candidates, random: seededRandom(seed) }));
			return outcome.ok ? outcome.selectors[0] : undefined;
		};
		expect(pick("scout\u0000recon the repo")).toBe(pick("scout\u0000recon the repo"));
		const distinct = new Set(["a", "b", "c", "d", "e", "f"].map(pick));
		expect(distinct.size).toBeGreaterThan(1);
	});
});

describe("usageScoreComponent headroom contract", () => {
	const p = pool("anthropic", { baseUrl: "https://api.anthropic.com" });
	const c = (usage: RoutingCandidateInput["usage"], fraction?: number): RoutingCandidateInput =>
		candidate({ selector: "x/a", pool: p, usage, usageRemainingFraction: fraction });

	it("healthy ladder adds 10 * fraction capped at 0..10", () => {
		expect(usageScoreComponent(c("healthy"))).toBe(30);
		expect(usageScoreComponent(c("healthy", 0))).toBe(30);
		expect(usageScoreComponent(c("healthy", 0.1))).toBeCloseTo(31);
		expect(usageScoreComponent(c("healthy", 0.5))).toBeCloseTo(35);
		expect(usageScoreComponent(c("healthy", 0.9))).toBeCloseTo(39);
		expect(usageScoreComponent(c("healthy", 1))).toBeCloseTo(40);
	});

	it("healthy fraction is clamped to [0,1]", () => {
		expect(usageScoreComponent(c("healthy", -0.5))).toBe(30);
		expect(usageScoreComponent(c("healthy", -100))).toBe(30);
		expect(usageScoreComponent(c("healthy", 1.5))).toBeCloseTo(40);
		expect(usageScoreComponent(c("healthy", 100))).toBeCloseTo(40);
	});

	it("unknown is 10 and ignores fraction", () => {
		expect(usageScoreComponent(c("unknown"))).toBe(10);
		expect(usageScoreComponent(c("unknown", 0))).toBe(10);
		expect(usageScoreComponent(c("unknown", 0.5))).toBe(10);
		expect(usageScoreComponent(c("unknown", 1))).toBe(10);
	});

	it("reserve is -40 and ignores fraction", () => {
		expect(usageScoreComponent(c("reserve"))).toBe(-40);
		expect(usageScoreComponent(c("reserve", 0))).toBe(-40);
		expect(usageScoreComponent(c("reserve", 0.5))).toBe(-40);
		expect(usageScoreComponent(c("reserve", 1))).toBe(-40);
	});

	it("depleted is 0 and ignores fraction", () => {
		expect(usageScoreComponent(c("depleted"))).toBe(0);
		expect(usageScoreComponent(c("depleted", 0))).toBe(0);
		expect(usageScoreComponent(c("depleted", 0.9))).toBe(0);
		expect(usageScoreComponent(c("depleted", 1))).toBe(0);
	});

	it("headroom preserves ladder gaps: healthy+fraction stays above unknown but below diversity penalty", () => {
		// worst healthy (30) beats unknown (10) by 20; best healthy (40) loses to sibling diversity (-30) vs worst healthy
		expect(usageScoreComponent(c("healthy", 0)) - usageScoreComponent(c("unknown", 1))).toBe(20);
		expect(usageScoreComponent(c("healthy", 1)) - usageScoreComponent(c("healthy", 0))).toBe(10);
		// reserve vs healthy gap is always 70+headroom, tested via router above but verified here
		expect(usageScoreComponent(c("healthy", 0)) - usageScoreComponent(c("reserve", 1))).toBe(70);
		expect(usageScoreComponent(c("healthy", 1)) - usageScoreComponent(c("reserve", 1))).toBe(80);
	});
});
