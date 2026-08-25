/**
 * Parent-context ingress budget contract.
 *
 * Each test names the consumer-visible failure it defends. The subject is the
 * MODEL-FACING payload (`result.content` text blocks) — the only thing the
 * provider is sent and the session persists — never TUI/display state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	applyParentIngressBudget,
	resolveParentIngressBudgetBytes,
	suppressDuplicateIngress,
} from "@oh-my-pi/pi-coding-agent/tools/ingress-budget";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");
}

/**
 * Session-manager seam the budget actually uses: artifact persistence plus the
 * active branch it consults for duplicate suppression.
 */
class FakeSessionManager {
	readonly saved = new Map<string, string>();
	branch: SessionEntry[] = [];
	failSaves = false;
	#next = 0;

	saveArtifact = async (text: string, _toolName: string): Promise<string> => {
		if (this.failSaves) throw new Error("disk full");
		const id = String(this.#next++);
		this.saved.set(id, text);
		return id;
	};

	getBranch = (): SessionEntry[] => this.branch;
}

function makeContext(
	sessionManager: FakeSessionManager,
	agentKind: "main" | "sub",
	budgetKb?: number,
): AgentToolContext {
	const settings = Settings.isolated();
	if (budgetKb !== undefined) settings.set("tools.parentIngressBudget", budgetKb);
	return { agentKind, settings, sessionManager } as unknown as AgentToolContext;
}

/** A tool result carrying `n` distinct, individually identifiable lines. */
function bulkText(n: number, tag = "line"): string {
	return Array.from({ length: n }, (_, i) => `${tag}-${String(i + 1).padStart(5, "0")} ${"payload ".repeat(8)}`).join(
		"\n",
	);
}

function toolResultEntry(id: string, toolName: string, text: string, prunedAt?: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-08-13T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text }],
			timestamp: 1,
			...(prunedAt === undefined ? {} : { prunedAt }),
		},
	} as unknown as SessionEntry;
}

describe("parent ingress budget", () => {
	let sessionManager: FakeSessionManager;

	beforeEach(() => {
		sessionManager = new FakeSessionManager();
	});

	it("defaults to a low-thousands-of-tokens budget, and 0 disables it", () => {
		// The measured default. A benchmark's useful evidence results topped out at
		// 4,936 chars while every harmful one started at 5,695; 6 KB separates them.
		expect(resolveParentIngressBudgetBytes(Settings.isolated())).toBe(6 * 1024);

		const off = Settings.isolated();
		off.set("tools.parentIngressBudget", 0);
		expect(resolveParentIngressBudgetBytes(off)).toBe(0);
	});

	describe("F4 — generated large output is externalized before parent ingress", () => {
		it("bounds a large generated result and returns a recoverable artifact pointer", async () => {
			const full = bulkText(600, "generated");
			const result: AgentToolResult = { content: [{ type: "text", text: full }] };

			const shaped = await applyParentIngressBudget(result, "bash", makeContext(sessionManager, "main"));
			const text = modelText(shaped);

			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 512);
			expect(text.length).toBeLessThan(full.length);
			// The exact bytes survive outside the context, addressable by selector.
			const artifactId = shaped.details?.meta?.truncation?.artifactId as string;
			expect(artifactId).toBeDefined();
			expect(sessionManager.saved.get(artifactId)).toBe(full);
			expect(text).toContain(`artifact://${artifactId}`);
			expect(text).toContain(`artifact://${artifactId}:1-200`);
			// Head is preserved so the model keeps orientation without a round trip.
			expect(text).toContain("generated-00001");
		});

		it("still bounds the result when externalizing fails, and says how to recover", async () => {
			sessionManager.failSaves = true;
			const full = bulkText(600, "generated");

			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"bash",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			// A failed save must never re-expose the full output.
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 512);
			expect(text).not.toContain("artifact://");
			expect(text).toContain("narrower scope");
		});
	});

	describe("F6 — structured output stays structurally valid", () => {
		it("replaces an oversized JSON payload with a valid compact envelope, never a byte slice", async () => {
			const payload = {
				rootCause: "pair matching requires exact effective_date equality",
				findings: Array.from({ length: 400 }, (_, i) => ({ id: i, note: `finding ${i} ${"detail ".repeat(10)}` })),
			};
			const full = JSON.stringify(payload, null, 2);
			expect(Buffer.byteLength(full, "utf-8")).toBeGreaterThan(6 * 1024);

			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"task",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			// The whole point: still parseable.
			const parsed = JSON.parse(text);
			expect(parsed.ompIngress).toBe("structured-output-externalized");
			expect(parsed.shape).toBe("object");
			expect(parsed.keys).toEqual(["rootCause", "findings"]);
			expect(parsed.full).toMatch(/^artifact:\/\//);
			expect(sessionManager.saved.get(parsed.full.replace("artifact://", ""))).toBe(full);
		});

		it("reports array shape and length for an oversized JSON array", async () => {
			const full = JSON.stringify(Array.from({ length: 900 }, (_, i) => ({ i, pad: "x".repeat(40) })));

			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"task",
				makeContext(sessionManager, "main"),
			);
			const parsed = JSON.parse(modelText(shaped));

			expect(parsed.shape).toBe("array");
			expect(parsed.length).toBe(900);
		});

		it("does not treat brace-prefixed non-JSON as structured", async () => {
			const full = `{ this is not json\n${bulkText(400, "brace")}`;

			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"bash",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			expect(() => JSON.parse(text)).toThrow();
			expect(text).toContain("brace-00001");
		});
	});

	describe("F2 — recovery routes are never fabricated", () => {
		it("omits a line range for a path-sourced result that is not line-addressable", async () => {
			// Shape of a SQLite table dump: `source.type === "path"`, but the body is
			// a rendered table with no line numbers and no line-based truncation, and
			// it pages by query syntax. A `db.sqlite:401-600` selector would be read
			// as a table name and the recovery call would fail outright.
			const rows = Array.from({ length: 400 }, (_, i) => `| ${i} | account-${i} | 2026-08-13 | ${"x".repeat(40)} |`);
			const full = ["| id | name | date | note |", ...rows].join("\n");

			const shaped = await applyParentIngressBudget(
				{
					content: [{ type: "text", text: full }],
					details: { meta: { source: { type: "path", value: "/tmp/ledger.sqlite" } } },
				},
				"read",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			expect(shaped.details?.meta?.ingress?.shapedAs).toBe("file");
			expect(text).not.toMatch(/range selector, e\.g\./);
			expect(text).toContain("narrower selector");
			expect(text).toContain("/tmp/ledger.sqlite");
			// Still bounded, and still not copied into session storage.
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 512);
			expect(sessionManager.saved.size).toBe(0);
		});

		it("derives the resume line from shownRange when the body has no line prefixes", async () => {
			const full = bulkText(400, "raw");
			const shaped = await applyParentIngressBudget(
				{
					content: [{ type: "text", text: full }],
					details: {
						meta: {
							source: { type: "path", value: "/tmp/big.txt" },
							truncation: { shownRange: { start: 5000, end: 5399 } },
						},
					},
				},
				"read",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			// The excerpt began at source line 5000, so the resume line must be far
			// past it — counting the excerpt from 1 would name the wrong region.
			const match = /range selector, e\.g\. `\/tmp\/big\.txt:(\d+)-/.exec(text);
			expect(match).not.toBeNull();
			expect(Number((match as RegExpExecArray)[1])).toBeGreaterThan(5000);
		});
	});

	describe("F7 — failure diagnostics survive the bound", () => {
		it("keeps both the invocation head and the failing tail of a large error", async () => {
			const full = [
				"$ pytest tests/",
				bulkText(500, "noise"),
				"E   AssertionError: destination_account_id was None",
				"exit status 1",
			].join("\n");

			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }], isError: true },
				"bash",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 512);
			// Tail-weighted: the diagnosis lives at the end of a failing run.
			expect(text).toContain("AssertionError: destination_account_id was None");
			expect(text).toContain("exit status 1");
			expect(text).toContain("$ pytest tests/");
			expect(shaped.isError).toBe(true);
		});
	});

	describe("F9 — subagent investigation is not starved", () => {
		it("leaves an identical oversized result untouched for a subagent", async () => {
			const full = bulkText(600, "worker");
			const forSub = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "sub"),
			);
			const forMain = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(forSub)).toBe(full);
			expect(sessionManager.saved.size).toBe(1); // only the parent shaping externalized
			expect(modelText(forMain).length).toBeLessThan(full.length);
		});

		it("leaves the parent unbounded when the budget is disabled", async () => {
			const full = bulkText(600, "off");
			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main", 0),
			);
			expect(modelText(shaped)).toBe(full);
		});
	});

	describe("F3 — duplicate ingress is suppressed, but only while genuinely present", () => {
		it("replaces a body the active context already holds with a compact reference", () => {
			const full = bulkText(600, "dupe");
			sessionManager.branch = [toolResultEntry("e1", "grep", full)];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);
			const text = modelText(shaped);

			expect(text).not.toContain("dupe-00300");
			expect(text).toContain("already in this conversation");
			expect(text).toContain("call-e1");
			expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(1024);
		});

		it("lets changed content through instead of falsely deduplicating it", () => {
			sessionManager.branch = [toolResultEntry("e1", "grep", bulkText(600, "dupe"))];
			const changed = `${bulkText(600, "dupe")}\nnew-evidence-line`;

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: changed }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(shaped)).toBe(changed);
		});

		it("lets the body back in once compaction pruned the earlier copy", () => {
			const full = bulkText(600, "dupe");
			sessionManager.branch = [toolResultEntry("e1", "grep", full, Date.now())];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			// The prior result is no longer in context; suppressing would starve the model.
			expect(modelText(shaped)).toBe(full);
		});

		it("lets the body back in once compaction summarized the earlier copy away", () => {
			// Compaction does NOT set prunedAt: it moves the context window forward
			// via firstKeptEntryId. Trusting prunedAt alone would tell the model to
			// "scroll back" to a body that is no longer in its context, and throw
			// away the fresh copy.
			const full = bulkText(600, "dupe");
			sessionManager.branch = [
				toolResultEntry("e1", "grep", full),
				{
					type: "compaction",
					id: "c1",
					parentId: "e1",
					timestamp: "2026-08-13T00:00:05.000Z",
					summary: "earlier investigation summarized",
					firstKeptEntryId: "e2",
					tokensBefore: 90_000,
				} as unknown as SessionEntry,
				toolResultEntry("e2", "grep", "unrelated later result"),
			];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(shaped)).toBe(full);
		});

		it("still suppresses a duplicate that lives after the compaction boundary", () => {
			const full = bulkText(600, "dupe");
			sessionManager.branch = [
				toolResultEntry("e0", "grep", "pre-compaction noise"),
				{
					type: "compaction",
					id: "c1",
					parentId: "e0",
					timestamp: "2026-08-13T00:00:05.000Z",
					summary: "summarized",
					firstKeptEntryId: "e1",
					tokensBefore: 90_000,
				} as unknown as SessionEntry,
				toolResultEntry("e1", "grep", full),
			];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(shaped)).toContain("already in this conversation");
			expect(modelText(shaped)).toContain("call-e1");
		});

		it("does not match an identical payload produced by a different tool", () => {
			const full = bulkText(600, "dupe");
			sessionManager.branch = [toolResultEntry("e1", "read", full)];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: full }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(shaped)).toBe(full);
		});

		it("repeats small results rather than explaining them", () => {
			const small = "one short line of evidence";
			sessionManager.branch = [toolResultEntry("e1", "grep", small)];

			const shaped = suppressDuplicateIngress(
				{ content: [{ type: "text", text: small }] },
				"grep",
				makeContext(sessionManager, "main"),
			);

			expect(modelText(shaped)).toBe(small);
		});
	});

	describe("F8 — transcript rebuild does not re-expand externalized content", () => {
		it("replays the shaped body verbatim and never the elided source", async () => {
			const full = bulkText(600, "persisted");
			const shaped = await applyParentIngressBudget(
				{ content: [{ type: "text", text: full }] },
				"bash",
				makeContext(sessionManager, "main"),
			);
			const shapedText = modelText(shaped);

			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-08-13T00:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "investigate" }], timestamp: 1 },
				} as unknown as SessionEntry,
				{
					type: "message",
					id: "a1",
					parentId: "u1",
					timestamp: "2026-08-13T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
						timestamp: 2,
					},
				} as unknown as SessionEntry,
				{
					type: "message",
					id: "r1",
					parentId: "a1",
					timestamp: "2026-08-13T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "bash",
						content: shaped.content,
						timestamp: 3,
					},
				} as unknown as SessionEntry,
			];

			const rebuilt = buildSessionContext(entries);
			const rebuiltResult = rebuilt.messages.find(m => m.role === "toolResult");

			expect(rebuiltResult).toBeDefined();
			const rebuiltText = modelText(rebuiltResult as { content: Array<{ type: string; text?: string }> });
			expect(rebuiltText).toBe(shapedText);
			// The elided middle must not reappear on reload.
			expect(rebuiltText).not.toContain("persisted-00300");
			// The recovery pointer must still be there to use.
			expect(rebuiltText).toMatch(/artifact:\/\/\d+/);
		});
	});
});

describe("parent ingress budget — read tool", () => {
	let testDir: string;
	let tool: AgentTool;
	let sessionManager: FakeSessionManager;
	let bigFile: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "parent-ingress-read-"));
		bigFile = path.join(testDir, "big.txt");
		// Plain text: no tree-sitter parser, so structural summarization cannot
		// apply and the raw body is what would otherwise reach the model.
		await Bun.write(bigFile, bulkText(900, "src"));
		sessionManager = new FakeSessionManager();
		const session = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => path.join(testDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(testDir, "session"),
			settings: Settings.isolated(),
		} as unknown as ToolSession;
		tool = wrapToolWithMetaNotice(new ReadTool(session) as unknown as AgentTool);
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("F1 — bounds an oversized whole-file parent read and offers exact range recovery", async () => {
		const context = makeContext(sessionManager, "main");
		const result = await tool.execute("call-1", { path: bigFile, i: "read" }, undefined, undefined, context);
		const text = modelText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 1024);
		// Identifies its source and scale, and hands over a usable selector.
		expect(text).toContain(bigFile);
		expect(text).toContain("source of truth");
		expect(text).toMatch(new RegExp(`${bigFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+-\\d+`));
		// A source file is never copied into an artifact to dodge context.
		expect(sessionManager.saved.size).toBe(0);
		expect(text).not.toContain("artifact://");
	});

	it("F2 — preserves an explicit narrow range verbatim", async () => {
		const context = makeContext(sessionManager, "main");
		const result = await tool.execute(
			"call-2",
			{ path: `${bigFile}:10-20`, i: "read" },
			undefined,
			undefined,
			context,
		);
		const text = modelText(result);

		// Small, deliberately-scoped evidence must not be over-summarized.
		expect(text).toContain("src-00010");
		expect(text).toContain("src-00020");
		expect(text).not.toContain("source of truth");
		expect(text).not.toContain("Parent ingress budget");
	});

	it("F1 — the suggested recovery range starts at the first line NOT already shown", async () => {
		const context = makeContext(sessionManager, "main");
		// Start at an offset: the excerpt's own line count would name the wrong
		// region here, so the selector must come from real source line numbers.
		const result = await tool.execute(
			"call-offset",
			{ path: `${bigFile}:400-900`, i: "read" },
			undefined,
			undefined,
			context,
		);
		const text = modelText(result);

		// Anchor on the notice itself so no incidental `N-M` elsewhere can match.
		const suggested = /range selector, e\.g\. `.*:(\d+)-(\d+)`/.exec(text);
		expect(suggested).not.toBeNull();
		const nextStart = Number((suggested as RegExpExecArray)[1]);

		// The invariant, independent of how many lines the read happened to return:
		// the selector resumes exactly one line past the highest line displayed.
		const displayed = [...text.matchAll(/^[ *]?(\d+)(?:-(\d+))?:/gm)].map(m => Number(m[2] ?? m[1]));
		expect(displayed.length).toBeGreaterThan(0);
		expect(nextStart).toBe(Math.max(...displayed) + 1);
	});

	it("F1 — never fabricates a numeric range when the excerpt carries no line numbers", async () => {
		const context = makeContext(sessionManager, "main");
		// `:raw` suppresses line numbering, so no resume line is derivable. A
		// counted-from-1 guess would point hundreds of lines from the truth.
		const result = await tool.execute(
			"call-raw",
			{ path: `${bigFile}:400-900:raw`, i: "read" },
			undefined,
			undefined,
			context,
		);
		const text = modelText(result);

		expect(text).toContain("Parent ingress budget");
		expect(text).not.toMatch(/range selector, e\.g\./);
		expect(text).toContain("narrower selector");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 1024);
		expect(text).toContain(bigFile);
	});

	it("F1 — bounds an explicitly requested range that is itself too large, and says how to page", async () => {
		const context = makeContext(sessionManager, "main");
		const result = await tool.execute(
			"call-3",
			{ path: `${bigFile}:1-900`, i: "read" },
			undefined,
			undefined,
			context,
		);
		const text = modelText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 1024);
		expect(text).toContain("Recover exact evidence with a range selector");
		expect(sessionManager.saved.size).toBe(0);
	});

	it("F9 — leaves the same oversized whole-file read intact for a subagent", async () => {
		const context = makeContext(sessionManager, "sub");
		const result = await tool.execute("call-4", { path: bigFile, i: "read" }, undefined, undefined, context);
		const text = modelText(result);

		expect(text).not.toContain("Parent ingress budget");
		expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(6 * 1024);
	});
});

/**
 * F5 — the delegated-result contract, and the top-ranked measured contributor.
 *
 * Bounding the `task` result already worked before this change (measured 587–614
 * chars in the Layer-2 benchmark), but the parent then read the `agent://`
 * pointer, which had no size bound at all — 66,114 chars across six benchmark
 * runs, 38% of all read ingress, up to 12,087 chars in one call. Deferring
 * ingress is not bounding it.
 */
describe("parent ingress budget — agent:// delegated output", () => {
	let testDir: string;
	let artifactDir: string;
	let unregister: (() => void) | undefined;
	let tool: AgentTool;
	let sessionManager: FakeSessionManager;
	let fullReport: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "parent-ingress-agent-"));
		artifactDir = path.join(testDir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		fullReport = bulkText(500, "finding");
		await Bun.write(path.join(artifactDir, "BigScout.md"), fullReport);
		resetRegisteredArtifactDirsForTests();
		unregister = registerArtifactsDir(artifactDir);
		sessionManager = new FakeSessionManager();
		const session = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => path.join(testDir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactDir,
			settings: Settings.isolated(),
		} as unknown as ToolSession;
		tool = wrapToolWithMetaNotice(new ReadTool(session) as unknown as AgentTool);
	});

	afterEach(async () => {
		unregister?.();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("bounds a large agent:// read and keeps the pointer usable for paging", async () => {
		const result = await tool.execute(
			"call-agent",
			{ path: "agent://BigScout", i: "read" },
			undefined,
			undefined,
			makeContext(sessionManager, "main"),
		);
		const text = modelText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(6 * 1024 + 1024);
		expect(text).toContain("finding-00001");
		expect(text).not.toContain("finding-00400");
		// The pointer is already durable; it must not be copied into an artifact.
		expect(sessionManager.saved.size).toBe(0);
		expect(text).toContain("agent://BigScout:");
		expect(result.details?.meta?.ingress?.shapedAs).toBe("pointer");
	});

	it("returns the exact cited region when the parent pages the pointer", async () => {
		const result = await tool.execute(
			"call-agent-range",
			{ path: "agent://BigScout:400-410", i: "read" },
			undefined,
			undefined,
			makeContext(sessionManager, "main"),
		);
		const text = modelText(result);

		// Recovery must actually work, and a narrow page must arrive unshaped.
		expect(text).toContain("finding-00400");
		expect(text).toContain("finding-00410");
		expect(text).not.toContain("Parent ingress budget");
	});

	it("leaves the same agent:// read unbounded for a subagent", async () => {
		const result = await tool.execute(
			"call-agent-sub",
			{ path: "agent://BigScout", i: "read" },
			undefined,
			undefined,
			makeContext(sessionManager, "sub"),
		);
		expect(Buffer.byteLength(modelText(result), "utf-8")).toBeGreaterThan(6 * 1024);
	});
});
