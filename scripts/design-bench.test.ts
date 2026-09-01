import { describe, expect, test } from "bun:test";
import {
	aggregateByModel,
	type BlindMap,
	blindAssign,
	type CandidateRecord,
	canonicalJson,
	classifyOutcome,
	DESIGN_BENCH_SCHEMA,
	designDrift,
	extractFinalOutput,
	formatScoreResult,
	type RunManifest,
	renderReport,
	reviewIndex,
	reviewReady,
	seedFromString,
	validateRubric,
	validateScoreInput,
} from "./design-bench";
import type { BenchRun } from "./orchestration-bench";

// ---------------------------------------------------------------------------
// Fixture builders — synthetic records, no provider or disk involvement.
// ---------------------------------------------------------------------------

const RUBRIC = {
	version: 1,
	total: 60, // must equal the summed weights below
	criteria: [
		{ id: "visual-quality", name: "Visual quality", weight: 25 },
		{ id: "hierarchy", name: "Hierarchy / glanceability", weight: 20 },
		{ id: "genuine-redesign", name: "Genuine redesign", weight: 15 },
	],
	deductions: [
		{ id: "fabricated-metrics", description: "Fabricated metrics presented as truthful", points: 15 },
		{ id: "stacked-cards", description: "Stacked generic cards as primary composition", points: 10 },
	],
};

function benchRun(overrides: Partial<BenchRun> = {}): BenchRun {
	return {
		schema: DESIGN_BENCH_SCHEMA,
		control: {
			label: "test",
			model: "provider/model-a",
			cwd: "/workspace-a",
			promptFile: "/prompts/p.md",
			promptSha256: "aaaa",
			promptChars: 10,
			gitHead: null,
			worktreeSha256: null,
			harnessSha256: "harness-1",
			startedAt: new Date(0).toISOString(),
		},
		process: { exitCode: 0, wallClockMs: 1000, stderrTail: "" },
		metrics: null,
		error: null,
		...overrides,
	};
}

function record(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
	return {
		schema: DESIGN_BENCH_SCHEMA,
		label: "candidate-001",
		runIndex: 1,
		modelSelector: "provider/model-a",
		modelNormalized: "model-a",
		benchmarkSha256: "bench-1",
		promptSha256: "aaaa",
		fixtureSha256: "fixture-1",
		thinking: null,
		capabilities: "{}",
		requiredProofs: ["proofs/mobile-390-dark.png"],
		status: "success",
		failureReason: null,
		startedAt: new Date(0).toISOString(),
		endedAt: new Date(1000).toISOString(),
		wallClockMs: 1000,
		transcript: null,
		finalOutput: null,
		proofCheck: { ok: true, missing: [] },
		bench: benchRun(),
		...overrides,
	};
}

describe("F1 — prompt drift", () => {
	test("different prompt hashes are reported as drift and not silently comparable", () => {
		const a = record();
		const b = record({ label: "candidate-002", bench: benchRun({ control: benchRun().control }) });
		b.bench!.control = { ...b.bench!.control, promptSha256: "bbbb" };
		b.promptSha256 = "bbbb";
		const drift = designDrift([a, b]);
		expect(drift.map(entry => entry.key)).toContain("promptSha256");
	});
});

describe("F2 — fixture/source drift", () => {
	test("different fixture fingerprints are reported as drift", () => {
		const a = record();
		const b = record({ label: "candidate-002", fixtureSha256: "fixture-2" });
		const drift = designDrift([a, b]);
		const fixture = drift.find(entry => entry.key === "fixtureSha256");
		expect(fixture).toBeDefined();
		expect(fixture!.values.sort()).toEqual(["fixture-1", "fixture-2"]);
	});
});

describe("F2b — tool/capability drift", () => {
	test("differing frozen capability surfaces are reported as drift", () => {
		const a = record();
		const b = record({ label: "candidate-002", capabilities: canonicalJson({ tools: "browser-only" }) });
		const drift = designDrift([a, b]);
		expect(drift.map(entry => entry.key)).toContain("capabilities");
	});

	test("model-only variation with identical capability surface stays clean", () => {
		const a = record();
		const b = record({
			label: "candidate-002",
			modelSelector: "provider/model-b",
			bench: benchRun({ control: { ...benchRun().control, model: "provider/model-b" } }),
		});
		expect(designDrift([a, b])).toEqual([]);
	});

	test("capability fingerprint is key-order independent", () => {
		expect(canonicalJson({ tools: "default", config: { a: 1, b: 2 } })).toBe(
			canonicalJson({ config: { b: 2, a: 1 }, tools: "default" }),
		);
	});
});

describe("F3 — missing proof", () => {
	test("exit 0 with missing proofs is invalid, not review-ready", () => {
		const outcome = classifyOutcome(benchRun(), { ok: false, missing: ["proofs/mobile-390-dark.png"] }, 1000, 60000);
		expect(outcome.status).toBe("invalid");
		const rec = record({
			status: outcome.status,
			proofCheck: { ok: false, missing: ["proofs/mobile-390-dark.png"] },
		});
		expect(reviewReady(rec)).toBe(false);
	});
});

describe("F4 — output collision", () => {
	test("labels are unique across models × repeats and deterministic for a seed", () => {
		const models = ["provider/model-a", "provider/model-b", "provider/model-c"];
		const entries = blindAssign(models, 2, 42);
		const labels = entries.map(entry => entry.label);
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels.every(label => /^candidate-\d{3}$/.test(label))).toBe(true);
		expect(blindAssign(models, 2, 42)).toEqual(entries);
		const map: BlindMap = { seed: 42, entries };
		const pairs = map.entries.map(entry => `${entry.label}:${entry.model}:${entry.runIndex}`);
		expect(new Set(pairs).size).toBe(pairs.length);
	});
});

describe("F5 — blind-map leakage", () => {
	test("review index and blind report contain no model identity", () => {
		const records = [
			record({ modelSelector: "provider/claude-opus-4-8", modelNormalized: "claude-opus-4-8" }),
			record({
				label: "candidate-002",
				runIndex: 2,
				modelSelector: "openai/gpt-6.2",
				modelNormalized: "gpt-6.2",
				bench: benchRun({ control: { ...benchRun().control, model: "openai/gpt-6.2" } }),
			}),
		];
		const rows = reviewIndex(records);
		expect(JSON.stringify(rows)).not.toContain("claude");
		expect(JSON.stringify(rows)).not.toContain("gpt-6.2");
		expect(JSON.stringify(rows)).not.toContain("modelSelector");
	});
});

describe("F6 — failed run honesty", () => {
	test("non-zero exit, timeout, and attribution failure are classified and excluded from aggregates", () => {
		const failed = classifyOutcome(
			benchRun({ process: { exitCode: 1, wallClockMs: 500, stderrTail: "boom" } }),
			null,
			500,
			60000,
		);
		expect(failed.status).toBe("failed");
		const timeout = classifyOutcome(
			benchRun({ process: { exitCode: null, wallClockMs: 60000, stderrTail: "" } }),
			null,
			60000,
			60000,
		);
		expect(timeout.status).toBe("timeout");
		const partial = classifyOutcome(
			benchRun({ error: "session header missing from stdout" }),
			{ ok: true, missing: [] },
			500,
			60000,
		);
		expect(partial.status).toBe("partial");
		const rec = record({ status: "failed", failureReason: "exit code 1: boom" });
		expect(reviewReady(rec)).toBe(false);
	});
});

describe("F7 — scoring bounds", () => {
	test("out-of-range, missing, and unknown-deduction scores are rejected", () => {
		expect(() =>
			validateScoreInput({ scores: { "visual-quality": 30, hierarchy: 10, "genuine-redesign": 5 } }, RUBRIC),
		).toThrow();
		expect(() =>
			validateScoreInput({ scores: { "visual-quality": -1, hierarchy: 10, "genuine-redesign": 5 } }, RUBRIC),
		).toThrow();
		expect(() => validateScoreInput({ scores: { "visual-quality": 20, hierarchy: 10 } }, RUBRIC)).toThrow();
		expect(() =>
			validateScoreInput(
				{ scores: { "visual-quality": 20, hierarchy: 10, "genuine-redesign": 5 }, deductions: ["no-such-flag"] },
				RUBRIC,
			),
		).toThrow();
	});
	test("legal scores total correctly with deductions clamped at zero", () => {
		const total = validateScoreInput(
			{
				scores: { "visual-quality": 20, hierarchy: 15, "genuine-redesign": 10 },
				deductions: ["fabricated-metrics"],
			},
			RUBRIC,
		);
		expect(total).toBe(30);
		const floored = validateScoreInput(
			{
				scores: { "visual-quality": 0, hierarchy: 0, "genuine-redesign": 0 },
				deductions: ["fabricated-metrics", "stacked-cards"],
			},
			RUBRIC,
		);
		expect(floored).toBe(0);
	});
	test("rubric totals must equal summed weights", () => {
		expect(() => validateRubric({ ...RUBRIC, total: 99 })).toThrow();
		expect(() => validateRubric(RUBRIC)).not.toThrow();
	});
});

describe("F8 — incomplete grading", () => {
	test("ungraded candidates are distinguishable from zero-score candidates", () => {
		const records = [record({ label: "candidate-001" }), record({ label: "candidate-002" })];
		const scores = new Map([
			[
				"candidate-001",
				{
					candidate: "candidate-001",
					scores: { "visual-quality": 0, hierarchy: 0, "genuine-redesign": 0 },
					deductions: [],
					note: "",
					reviewer: "chris",
					timestamp: new Date(0).toISOString(),
					total: 0,
				},
			],
		]);
		const map: BlindMap = {
			seed: 1,
			entries: [
				{ label: "candidate-001", model: "provider/model-a", runIndex: 1 },
				{ label: "candidate-002", model: "provider/model-a", runIndex: 1 },
			],
		};
		const [aggregate] = aggregateByModel(records, scores, map, RUBRIC);
		expect(aggregate.ungraded).toBe(1);
		expect(aggregate.validRuns).toBe(1);
		expect(aggregate.totals).toEqual([0]);
		expect(aggregate.mean).toBe(0);
	});
});

describe("F9 — repeats", () => {
	test("repeated runs keep separate labels and separate totals", () => {
		const entries = blindAssign(["provider/model-a"], 3, 7);
		expect(entries.length).toBe(3);
		expect(new Set(entries.map(entry => entry.label)).size).toBe(3);
		expect(entries.every(entry => entry.runIndex >= 1 && entry.runIndex <= 3)).toBe(true);
		const records = entries.map((entry, index) =>
			record({ label: entry.label, runIndex: entry.runIndex, wallClockMs: 1000 * (index + 1) }),
		);
		const totals = [40, 60, 80];
		const scores = new Map(
			records.map((rec, index) => [
				rec.label,
				{
					candidate: rec.label,
					scores: { "visual-quality": totals[index], hierarchy: 0, "genuine-redesign": 0 },
					deductions: [],
					note: "",
					reviewer: "chris",
					timestamp: new Date(0).toISOString(),
					total: totals[index],
				},
			]),
		);
		const map: BlindMap = { seed: 7, entries };
		const [aggregate] = aggregateByModel(records, scores, map, RUBRIC);
		expect(aggregate.runs).toBe(3);
		expect(aggregate.validRuns).toBe(3);
		expect(aggregate.runLabels).toEqual(entries.map(entry => entry.label));
		expect(aggregate.totals).toEqual([40, 60, 80]);
		expect(aggregate.mean).toBe(60);
		expect(aggregate.median).toBe(60);
		expect(aggregate.best).toBe(80);
		expect(aggregate.worst).toBe(40);
		expect(designDrift(records)).toEqual([]);
	});
});

describe("F10 — control variable", () => {
	test("model-only differences produce a clean (empty) drift report", () => {
		const a = record({ modelSelector: "provider/model-a" });
		const b = record({
			label: "candidate-002",
			runIndex: 2,
			modelSelector: "provider/model-b",
			bench: benchRun({ control: { ...benchRun().control, model: "provider/model-b" } }),
		});
		expect(designDrift([a, b])).toEqual([]);
	});
});

describe("report denominator", () => {
	test("per-model report uses the active rubric total, not a hard-coded 100", () => {
		const manifest: RunManifest = {
			schema: DESIGN_BENCH_SCHEMA,
			benchmarkId: "mini",
			benchmarkVersion: 1,
			benchmarkSha256: "bench-1",
			definitionFile: "/def.json",
			promptFile: "/prompt.md",
			rubricFile: "/rubric.json",
			rubricSha256: "rubric-1",
			fixtureDir: "/fixture",
			fixtureSha256: "fixture-1",
			requiredProofs: ["proofs/x.png"],
			proofViewport: {},
			models: ["provider/model-a"],
			repeat: 1,
			seed: 1,
			thinking: null,
			timeoutMs: 60000,
			capabilities: "{}",
			configFiles: [],
			createdAt: new Date(0).toISOString(),
			candidates: [{ label: "candidate-001", runIndex: 1, status: "success" }],
		};
		const records = [record()];
		const scores = new Map([
			[
				"candidate-001",
				{
					candidate: "candidate-001",
					scores: { "visual-quality": 20, hierarchy: 10, "genuine-redesign": 5 },
					deductions: [],
					note: "",
					reviewer: "chris",
					timestamp: new Date(0).toISOString(),
					total: 35,
				},
			],
		]);
		const map: BlindMap = { seed: 1, entries: [{ label: "candidate-001", model: "provider/model-a", runIndex: 1 }] };
		const revealed = renderReport({ manifest, records, scores, rubric: RUBRIC, map, reveal: true });
		// RUBRIC totals 60 (25+20+15), so the denominator must be 60, never 100.
		expect(revealed).toContain("of 60");
		expect(revealed).not.toContain("of 100");
	});

	test("score command success line uses the rubric total as denominator", () => {
		const line = formatScoreResult("candidate-001", 35, RUBRIC.total, "/run/scores/candidate-001.json");
		expect(line).toContain("total 35/60");
		expect(line).not.toContain("/100");
	});
});

describe("helpers", () => {
	test("seedFromString is stable", () => {
		expect(seedFromString("dashboard")).toBe(seedFromString("dashboard"));
		expect(seedFromString("dashboard")).not.toBe(seedFromString("kitchen"));
	});

	test("extractFinalOutput returns the last assistant text", () => {
		const transcript = [
			JSON.stringify({ type: "session", id: "s1", timestamp: new Date(0).toISOString(), cwd: "/w" }),
			JSON.stringify({
				type: "message",
				timestamp: new Date(1).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "first" }] },
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date(2).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
			}),
			JSON.stringify({
				type: "message",
				timestamp: new Date(3).toISOString(),
				message: { role: "user", content: "hi" },
			}),
		].join("\n");
		expect(extractFinalOutput(transcript)).toBe("final answer");
	});
});
