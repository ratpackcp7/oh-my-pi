import { describe, expect, test } from "bun:test";
import {
	type BenchControl,
	type BenchRun,
	compareRuns,
	controlDrift,
	discoveryTarget,
	extractMetrics,
	extractSessionId,
	type OrchestrationMetrics,
	parseRepeat,
	stripReadSelector,
	type TranscriptInput,
} from "./orchestration-bench";

// ---------------------------------------------------------------------------
// Fixture builders — synthetic transcripts in the exact on-disk JSONL shape.
// ---------------------------------------------------------------------------

const CWD = "/repo";

/** Explicit ISO timestamps so ordering assertions are deliberate, not incidental. */
function at(millis: number): string {
	return new Date(millis).toISOString();
}

function header(): string {
	return JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: at(0), cwd: CWD });
}

interface AssistantOptions {
	millis: number;
	promptTokens?: number;
	input?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	duration?: number;
	calls?: ReadonlyArray<{ id: string; name: string; args?: Record<string, unknown> }>;
}

function assistant(options: AssistantOptions): string {
	return JSON.stringify({
		type: "message",
		id: `a-${options.millis}`,
		parentId: null,
		timestamp: at(options.millis),
		message: {
			role: "assistant",
			model: "test-model",
			provider: "test-provider",
			duration: options.duration ?? 100,
			usage: {
				input: options.input ?? 0,
				output: options.output ?? 0,
				cacheRead: options.cacheRead ?? 0,
				cacheWrite: options.cacheWrite ?? 0,
				totalTokens:
					(options.input ?? 0) + (options.output ?? 0) + (options.cacheRead ?? 0) + (options.cacheWrite ?? 0),
			},
			contextSnapshot: { promptTokens: options.promptTokens ?? 0 },
			content: (options.calls ?? []).map(call => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: call.args ?? {},
			})),
		},
	});
}

function toolResult(millis: number, callId: string, toolName: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id: `r-${callId}`,
		parentId: null,
		timestamp: at(millis),
		message: { role: "toolResult", toolCallId: callId, toolName, isError: false, content: [{ type: "text", text }] },
	});
}

function asyncResult(millis: number, text: string): string {
	return JSON.stringify({
		type: "custom_message",
		customType: "async-result",
		id: `c-${millis}`,
		parentId: null,
		timestamp: at(millis),
		content: text,
	});
}

function compaction(millis: number, tokensBefore: number): string {
	return JSON.stringify({
		type: "compaction",
		id: `k-${millis}`,
		parentId: null,
		timestamp: at(millis),
		summary: "compacted",
		firstKeptEntryId: "a-1",
		tokensBefore,
	});
}

function parentOf(...lines: string[]): TranscriptInput {
	return { file: "/sessions/x/2026-01-01T00-00-00-000Z_sess-1.jsonl", text: [header(), ...lines].join("\n") };
}

function childOf(agent: string, ...lines: string[]): TranscriptInput {
	return { file: `/sessions/x/2026-01-01T00-00-00-000Z_sess-1/${agent}.jsonl`, text: lines.join("\n") };
}

function readCall(id: string, filePath: string): { id: string; name: string; args: Record<string, unknown> } {
	return { id, name: "read", args: { path: filePath } };
}

// ---------------------------------------------------------------------------

describe("peak context", () => {
	test("reports the high-water mark, not the last turn", () => {
		// Failure mode: reading the final turn's context under-reports peak on any
		// session that compacted, which is every long session. G6 would then pass
		// on a run that actually blew through the window.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, promptTokens: 40_000 }),
				assistant({ millis: 2_000, promptTokens: 190_000 }),
				compaction(2_500, 190_000),
				assistant({ millis: 3_000, promptTokens: 25_000 }),
			),
		});
		expect(metrics.parent.peakContextTokens).toBe(190_000);
		expect(metrics.parent.finalContextTokens).toBe(25_000);
		expect(metrics.parent.compactions).toBe(1);
		expect(metrics.parent.peakCompactionTokens).toBe(190_000);
	});

	test("ignores turns with no context snapshot instead of collapsing peak to zero", () => {
		// Failure mode: an error turn without a snapshot resets peak to 0 and the
		// whole run reports as free.
		const metrics = extractMetrics({
			parent: parentOf(assistant({ millis: 1_000, promptTokens: 80_000 }), assistant({ millis: 2_000 })),
		});
		expect(metrics.parent.peakContextTokens).toBe(80_000);
		expect(metrics.parent.finalContextTokens).toBe(80_000);
	});
});

describe("parent input tokens", () => {
	test("counts cache reads and writes, not just fresh input", () => {
		// Failure mode: providers bill nearly everything as cacheRead/cacheWrite.
		// Summing `usage.input` alone reports ~2 tokens for a 40k-token prompt, so
		// the G6 input-token gate would "pass" while consumption grew.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, input: 2, cacheWrite: 40_435, output: 131 }),
				assistant({ millis: 2_000, input: 5, cacheRead: 40_435, output: 200 }),
			),
		});
		expect(metrics.parent.inputUncachedTokens).toBe(7);
		expect(metrics.parent.cacheWriteTokens).toBe(40_435);
		expect(metrics.parent.cacheReadTokens).toBe(40_435);
		expect(metrics.parent.inputTokens).toBe(80_877);
		expect(metrics.parent.outputTokens).toBe(331);
		expect(metrics.parent.turns).toBe(2);
	});
});

describe("delegated payload", () => {
	test("attributes task, hub and async-result payload to delegation and leaves raw reads out", () => {
		// Failure mode: counting every tool result as "delegated" makes a 43k-char
		// broad grep look like subagent bloat, sending the next fix at the wrong
		// mechanism entirely.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({
					millis: 1_000,
					calls: [{ id: "t1", name: "task" }, { id: "h1", name: "hub" }, readCall("r1", "src/big.ts")],
				}),
				toolResult(1_100, "t1", "task", "T".repeat(600)),
				toolResult(1_200, "h1", "hub", "H".repeat(90)),
				toolResult(1_300, "r1", "read", "R".repeat(43_144)),
				asyncResult(1_400, "A".repeat(2_000)),
			),
		});
		expect(metrics.delegation.delegatedResultChars).toBe(2_690);
		expect(metrics.delegation.delegatedCalls).toBe(3);
		expect(metrics.delegation.channels).toEqual({
			task: { calls: 1, chars: 600 },
			hub: { calls: 1, chars: 90 },
			"async-result": { calls: 1, chars: 2_000 },
		});
		expect(metrics.parent.toolResultChars).toBe(43_834);
		expect(metrics.largestToolResult).toEqual({ toolName: "read", chars: 43_144, target: "read /repo/src/big.ts" });
	});

	test("summarises child transcripts so delegated cost cannot hide off-parent", () => {
		// Failure mode: parent context drops 40% because the work moved to
		// subagents that cost more in total, and the report calls that a win.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, calls: [{ id: "t1", name: "task" }] }),
				toolResult(1_100, "t1", "task", "ok"),
			),
			children: [
				childOf(
					"Scout",
					assistant({ millis: 1_010, input: 10, cacheRead: 5_000, output: 400, duration: 2_500 }),
					toolResult(1_020, "c1", "read", "X".repeat(9_000)),
				),
			],
		});
		expect(metrics.delegation.children).toEqual([
			{
				agent: "Scout",
				turns: 1,
				inputTokens: 5_010,
				outputTokens: 400,
				toolResultChars: 9_000,
				modelDurationMs: 2_500,
			},
		]);
		expect(metrics.delegation.childInputTokens).toBe(5_010);
		expect(metrics.delegation.childTurns).toBe(1);
		expect(metrics.timing.childModelDurationMs).toBe(2_500);
	});

	test("counts a job's payload once per delivery, because the parent paid once per delivery", () => {
		// `hub jobs`/`hub wait` reprint a settled job's result on every call. Real
		// data shows one job block echoed eight times across a session.
		// Failure mode either way: dedupe it and `delegatedResultChars` understates
		// what the parent was actually charged, hiding repeated-polling waste;
		// leave the semantics undocumented and a reader treats the figure as
		// unique delegated information and blames subagent verbosity instead. The
		// per-channel call count is what distinguishes the two, so it is asserted.
		const payload = "RESULT-BODY".repeat(50);
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, calls: [{ id: "h1", name: "hub" }] }),
				asyncResult(1_050, payload),
				toolResult(1_100, "h1", "hub", payload),
				assistant({ millis: 2_000, calls: [{ id: "h2", name: "hub" }] }),
				toolResult(2_100, "h2", "hub", payload),
			),
		});
		expect(metrics.delegation.delegatedResultChars).toBe(payload.length * 3);
		expect(metrics.delegation.delegatedCalls).toBe(3);
		expect(metrics.delegation.channels).toEqual({
			hub: { calls: 2, chars: payload.length * 2 },
			"async-result": { calls: 1, chars: payload.length },
		});
	});
});

describe("duplicate rereads", () => {
	test("collapses read line selectors so a second slice of the same file counts", () => {
		// Failure mode: the parent re-reads a file a different way each time and
		// the retrace metric reports zero duplicates, which is how the Sol-high
		// run's retracing stayed invisible to the numbers.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, calls: [readCall("r1", "src/a.ts:1-40")] }),
				toolResult(1_100, "r1", "read", "A".repeat(1_000)),
				assistant({ millis: 2_000, calls: [readCall("r2", "src/a.ts:900-940")] }),
				toolResult(2_100, "r2", "read", "A".repeat(1_000)),
				assistant({ millis: 3_000, calls: [readCall("r3", "/repo/src/a.ts")] }),
				toolResult(3_100, "r3", "read", "A".repeat(1_000)),
			),
		});
		expect(metrics.rereads.selfDuplicateCalls).toBe(2);
		expect(metrics.rereads.selfDuplicateChars).toBe(2_000);
		expect(metrics.rereads.topTargets).toEqual([{ target: "read /repo/src/a.ts", count: 3, chars: 3_000 }]);
	});

	test("does not flag distinct targets as duplicates", () => {
		// Failure mode: an over-eager key (e.g. keyed on tool name only) reports
		// duplicates for every read and the metric becomes noise.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({
					millis: 1_000,
					calls: [
						readCall("r1", "src/a.ts"),
						readCall("r2", "src/b.ts"),
						{ id: "g1", name: "grep", args: { pattern: "foo", path: "src" } },
						{ id: "g2", name: "grep", args: { pattern: "bar", path: "src" } },
					],
				}),
			),
		});
		expect(metrics.rereads.selfDuplicateCalls).toBe(0);
		expect(metrics.rereads.topTargets).toEqual([]);
	});

	test("flags a parent read only when a child fetched it first and a result had arrived", () => {
		// Failure mode: blaming the parent for discovery it performed *before*
		// delegating turns legitimate scoping work into a false retrace signal.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, calls: [readCall("r1", "src/early.ts")] }),
				toolResult(1_050, "r1", "read", "E".repeat(500)),
				asyncResult(4_000, "scout reported"),
				assistant({ millis: 5_000, calls: [readCall("r2", "src/late.ts")] }),
				toolResult(5_050, "r2", "read", "L".repeat(700)),
			),
			children: [
				childOf(
					"Scout",
					assistant({ millis: 2_000, calls: [readCall("c1", "src/early.ts")] }),
					assistant({ millis: 3_000, calls: [readCall("c2", "src/late.ts")] }),
				),
			],
		});
		expect(metrics.rereads.afterDelegationCalls).toBe(1);
		expect(metrics.rereads.afterDelegationChars).toBe(700);
		expect(metrics.rereads.selfDuplicateCalls).toBe(0);
	});

	test("does not accuse the parent while subagents are still running", () => {
		// Failure mode: under parallel dispatch a child fetches a file at the same
		// moment the parent does. Nothing has been delivered yet, so the parent
		// could not have known — counting it as retracing invents a violation and
		// would push the next fix at a mechanism that is not misbehaving.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 5_000, calls: [readCall("r1", "src/shared.ts")] }),
				toolResult(5_050, "r1", "read", "S".repeat(400)),
			),
			children: [childOf("Scout", assistant({ millis: 2_000, calls: [readCall("c1", "src/shared.ts")] }))],
		});
		expect(metrics.delegation.delegatedResultChars).toBe(0);
		expect(metrics.rereads.afterDelegationCalls).toBe(0);
		expect(metrics.rereads.afterDelegationChars).toBe(0);
	});

	test("does not flag a target the parent reached before any child did", () => {
		// Failure mode: once a delivery has landed, treating *every* shared target
		// as retracing ignores direction. The parent read this file first and the
		// child followed — that is the parent scoping work, not repeating it.
		const metrics = extractMetrics({
			parent: parentOf(
				asyncResult(1_000, "scout reported"),
				assistant({ millis: 2_000, calls: [readCall("r1", "src/shared.ts")] }),
				toolResult(2_050, "r1", "read", "S".repeat(400)),
			),
			children: [childOf("Scout", assistant({ millis: 3_000, calls: [readCall("c1", "src/shared.ts")] }))],
		});
		expect(metrics.delegation.delegatedResultChars).toBeGreaterThan(0);
		expect(metrics.rereads.afterDelegationCalls).toBe(0);
	});

	test("a damaged child entry does not mask a later valid fetch of the same target", () => {
		// Failure mode: recording NaN as a target's first-seen time pins it — no
		// later value compares less than NaN — so the child's real, earlier fetch
		// is lost and genuine parent retracing goes unreported. Damage must not
		// buy the parent a clean score either.
		const brokenFirstTouch = JSON.stringify({
			type: "message",
			id: "c-broken",
			parentId: null,
			timestamp: "not-a-date",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: "src/shared.ts" } }],
			},
		});
		const metrics = extractMetrics({
			parent: parentOf(
				asyncResult(1_000, "scout reported"),
				assistant({ millis: 5_000, calls: [readCall("r1", "src/shared.ts")] }),
				toolResult(5_050, "r1", "read", "S".repeat(400)),
			),
			children: [
				childOf("Scout", brokenFirstTouch, assistant({ millis: 2_000, calls: [readCall("c1", "src/shared.ts")] })),
			],
		});
		expect(metrics.rereads.afterDelegationCalls).toBe(1);
		expect(metrics.rereads.afterDelegationChars).toBe(400);
	});

	test("an unparseable child timestamp is not charged to the parent", () => {
		// Failure mode: a damaged child entry used to pin that target's first-seen
		// time to NaN, after which every parent read of it was reported as
		// retracing regardless of true order — damage silently manufacturing the
		// exact violation the benchmark is looking for.
		const brokenChildTurn = JSON.stringify({
			type: "message",
			id: "c-broken",
			parentId: null,
			timestamp: "not-a-date",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/shared.ts" } }],
			},
		});
		const metrics = extractMetrics({
			parent: parentOf(
				asyncResult(1_000, "scout reported"),
				assistant({ millis: 5_000, calls: [readCall("r1", "src/shared.ts")] }),
				toolResult(5_050, "r1", "read", "S".repeat(400)),
			),
			children: [childOf("Scout", brokenChildTurn)],
		});
		expect(metrics.rereads.afterDelegationCalls).toBe(0);
		expect(metrics.rereads.afterDelegationChars).toBe(0);
	});
});

describe("timing", () => {
	test("removes idle gaps from active span while keeping them in transcript span", () => {
		// Failure mode: transcript span treats a two-hour interactive session as
		// two hours of run time, so any wall-clock gate (G8) is meaningless.
		const metrics = extractMetrics({
			parent: parentOf(
				assistant({ millis: 1_000, duration: 900 }),
				assistant({ millis: 4_000, duration: 1_100 }),
				assistant({ millis: 3_604_000, duration: 500 }),
			),
			idleGapMs: 10_000,
		});
		expect(metrics.timing.transcriptSpanMs).toBe(3_604_000);
		expect(metrics.timing.activeSpanMs).toBe(4_000);
		expect(metrics.timing.modelDurationMs).toBe(2_500);
		expect(metrics.timing.idleGapMs).toBe(10_000);
	});
});

describe("damaged transcripts", () => {
	test("counts undecodable lines and still measures the rest", () => {
		// Failure mode: a run killed mid-write throws during extraction, so the
		// only evidence of an expensive failed run is discarded.
		const text = [
			header(),
			assistant({ millis: 1_000, promptTokens: 12_000, input: 40, output: 9 }),
			'{"type":"message","message":{"role":"assis',
			"not json at all",
			"[1,2,3]",
		].join("\n");
		const metrics = extractMetrics({ parent: { file: "/sessions/x/a_sess-1.jsonl", text } });
		expect(metrics.malformedLines).toBe(3);
		expect(metrics.parent.turns).toBe(1);
		expect(metrics.parent.peakContextTokens).toBe(12_000);
		expect(metrics.session.id).toBe("sess-1");
	});

	test("returns a zeroed record for an empty transcript rather than throwing", () => {
		const metrics = extractMetrics({ parent: { file: "/sessions/x/a_sess-1.jsonl", text: "" } });
		expect(metrics.parent.turns).toBe(0);
		expect(metrics.parent.peakContextTokens).toBe(0);
		expect(metrics.session.id).toBe(null);
		expect(metrics.timing.transcriptSpanMs).toBe(0);
		expect(metrics.largestToolResult).toBe(null);
	});
});

describe("determinism", () => {
	test("two extractions of the same transcript are byte-identical", () => {
		// Failure mode: unordered map iteration or a wall-clock read leaks into the
		// record, so an A/B comparison measures harness noise as a model effect.
		const parent = parentOf(
			assistant({
				millis: 1_000,
				promptTokens: 50_000,
				input: 10,
				cacheRead: 100,
				calls: [readCall("r1", "src/a.ts"), { id: "t1", name: "task" }],
			}),
			toolResult(1_100, "r1", "read", "A".repeat(120)),
			toolResult(1_200, "t1", "task", "T".repeat(80)),
			assistant({ millis: 2_000, promptTokens: 60_000, calls: [readCall("r2", "src/a.ts")] }),
			toolResult(2_100, "r2", "read", "A".repeat(120)),
		);
		const children = [childOf("Scout", assistant({ millis: 1_500, calls: [readCall("c1", "src/a.ts")] }))];
		const first = JSON.stringify(extractMetrics({ parent, children }));
		const second = JSON.stringify(extractMetrics({ parent, children }));
		expect(second).toBe(first);
	});
});

describe("discoveryTarget", () => {
	test("keys by tool, pattern and resolved path; non-discovery tools are excluded", () => {
		// Failure mode: a grep and a read of the same directory collide, or
		// relative and absolute spellings of one file count as two targets.
		expect(discoveryTarget("read", { path: "src/a.ts" }, CWD)).toBe(
			discoveryTarget("read", { path: "/repo/src/a.ts" }, CWD),
		);
		expect(discoveryTarget("read", { path: "src/a.ts" }, CWD)).not.toBe(
			discoveryTarget("glob", { path: "src/a.ts" }, CWD),
		);
		expect(discoveryTarget("grep", { pattern: "foo", path: "src" }, CWD)).not.toBe(
			discoveryTarget("grep", { pattern: "bar", path: "src" }, CWD),
		);
		expect(discoveryTarget("task", { path: "src/a.ts" }, CWD)).toBe(null);
		expect(discoveryTarget("read", {}, CWD)).toBe(null);
	});

	test("leaves internal URLs and non-selector suffixes intact", () => {
		// Failure mode: chopping at the last colon turns `agent://Scout` into
		// `agent` and `db.sqlite:users` into `db.sqlite`, merging distinct resources.
		expect(stripReadSelector("agent://Scout")).toBe("agent://Scout");
		expect(stripReadSelector("db.sqlite:users")).toBe("db.sqlite:users");
		expect(stripReadSelector("src/a.ts:50-200")).toBe("src/a.ts");
		expect(stripReadSelector("src/a.ts:raw")).toBe("src/a.ts");
		expect(stripReadSelector("src/a.ts:5-16,960-973")).toBe("src/a.ts");
		expect(stripReadSelector("src/a.ts")).toBe("src/a.ts");
	});
});

describe("extractSessionId", () => {
	test("picks the session header and ignores other stream lines", () => {
		// Failure mode: attributing metrics to the wrong transcript, or failing to
		// find one at all, silently invalidates the whole run.
		const stdout = [
			"warning: something on stdout",
			// Stream events carry their own `id`. Matching on the first line that
			// merely has an `id` would attribute the run to a transcript that does
			// not exist, and the run would report as unmeasurable.
			'{"type":"stream_event","id":"msg-decoy","delta":"hi"}',
			'{"type":"session","version":3,"id":"019ff-abc","cwd":"/repo"}',
			'{"type":"session","version":3,"id":"later-id"}',
		].join("\n");
		expect(extractSessionId(stdout)).toBe("019ff-abc");
		expect(extractSessionId('{"type":"stream"}\nnot json')).toBe(null);
		expect(extractSessionId("")).toBe(null);
	});
});

describe("control drift", () => {
	function control(overrides: Partial<BenchControl> = {}): BenchControl {
		return {
			label: "bench",
			model: "provider/model:high",
			cwd: "/repo",
			promptFile: "/repo/prompt.md",
			promptSha256: "prompt-hash",
			promptChars: 100,
			gitHead: "abc123",
			worktreeSha256: "tree-hash",
			harnessSha256: "harness-hash",
			startedAt: "2026-01-01T00:00:00.000Z",
			...overrides,
		};
	}

	test("model-only difference is a valid comparison", () => {
		expect(controlDrift(control(), control({ model: "other/model" }))).toEqual([]);
	});

	test("reports every input that would invalidate a model comparison", () => {
		// Failure mode: the prior experiments relied on a human asserting "same
		// prompt, same code". A silent prompt or worktree change turns a model A/B
		// into a comparison of two different experiments.
		expect(controlDrift(control(), control({ promptSha256: "other" }))).toEqual(["promptSha256"]);
		expect(controlDrift(control(), control({ worktreeSha256: "dirty" }))).toEqual(["worktreeSha256"]);
		expect(controlDrift(control(), control({ gitHead: "def456", worktreeSha256: "dirty" }))).toEqual([
			"gitHead",
			"worktreeSha256",
		]);
		expect(controlDrift(control(), control({ harnessSha256: "changed" }))).toEqual(["harnessSha256"]);
		expect(controlDrift(control(), control({ cwd: "/other" }))).toEqual(["cwd"]);
	});
});

describe("compareRuns", () => {
	function run(metrics: Partial<OrchestrationMetrics["parent"]>, wallClockMs: number): BenchRun {
		const base = extractMetrics({ parent: { file: "/sessions/x/a_sess-1.jsonl", text: "" } });
		return {
			schema: 1,
			control: {
				label: "l",
				model: "m",
				cwd: "/repo",
				promptFile: "p",
				promptSha256: "h",
				promptChars: 1,
				gitHead: null,
				worktreeSha256: null,
				harnessSha256: "h",
				startedAt: "2026-01-01T00:00:00.000Z",
			},
			process: { exitCode: 0, wallClockMs, stderrTail: "" },
			metrics: { ...base, parent: { ...base.parent, ...metrics } },
			error: null,
		};
	}

	test("signs deltas against the baseline and leaves an undefined ratio null", () => {
		// Failure mode: a sign flip turns a 34% regression into a 34% improvement,
		// which is the exact number the previous gate decision hinged on.
		const rows = compareRuns(
			run({ peakContextTokens: 43_361, inputTokens: 0 }, 1_000),
			run({ peakContextTokens: 58_205, inputTokens: 10 }, 1_150),
		);
		const peak = rows.find(row => row.metric === "parent.peakContextTokens");
		expect(peak?.deltaPercent).toBeCloseTo(34.23, 2);
		expect(rows.find(row => row.metric === "process.wallClockMs")?.deltaPercent).toBeCloseTo(15, 5);
		expect(rows.find(row => row.metric === "parent.inputTokens")?.deltaPercent).toBe(null);
	});
});

describe("parseRepeat", () => {
	test("rejects values that would run zero benchmarks while reporting success", () => {
		// Failure mode: `--repeat tree` used to yield NaN, the run loop never
		// executed, and `runs.every(...)` on an empty array exited 0. A scripted
		// caller would bank a green measurement of nothing.
		expect(parseRepeat(undefined)).toBe(1);
		expect(parseRepeat("3")).toBe(3);
		expect(parseRepeat("tree")).toBe(null);
		expect(parseRepeat("0")).toBe(null);
		expect(parseRepeat("-2")).toBe(null);
		expect(parseRepeat("1.5")).toBe(null);
		expect(parseRepeat("")).toBe(null);
	});
});
