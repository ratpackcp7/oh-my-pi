/**
 * RED evidence for the parent-context ingress budget SPEC.
 *
 * This file uses ONLY pre-existing public API, so it runs unchanged on the
 * clean pre-fix base (`origin/main` @ ae2d3d6ea). Every assertion states the
 * post-fix contract; each one must fail here for the intended reason —
 * unbounded first-ingress of a single tool result into the top-level session —
 * not because a module is missing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const BUDGET_BYTES = 6 * 1024;

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text as string)
		.join("\n");
}

function bulkText(n: number, tag = "line"): string {
	return Array.from({ length: n }, (_, i) => `${tag}-${String(i + 1).padStart(5, "0")} ${"payload ".repeat(8)}`).join(
		"\n",
	);
}

class FakeSessionManager {
	readonly saved = new Map<string, string>();
	#next = 0;
	saveArtifact = async (text: string): Promise<string> => {
		const id = String(this.#next++);
		this.saved.set(id, text);
		return id;
	};
	getBranch = () => [];
}

describe("RED — parent ingress is unbounded on the pre-fix base", () => {
	let testDir: string;
	let readTool: AgentTool;
	let sessionManager: FakeSessionManager;
	let bigFile: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ingress-red-"));
		bigFile = path.join(testDir, "big.txt");
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
		readTool = wrapToolWithMetaNotice(new ReadTool(session) as unknown as AgentTool);
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function mainContext(): AgentToolContext {
		return {
			agentKind: "main",
			settings: Settings.isolated(),
			sessionManager,
		} as unknown as AgentToolContext;
	}

	it("F1 — an oversized whole-file parent read must be bounded with range recovery", async () => {
		const result = await readTool.execute("c1", { path: bigFile, i: "read" }, undefined, undefined, mainContext());
		const text = modelText(result);

		// Pre-fix: the read's own 300-line/150 KB limit is the only bound, so a
		// single result injects ~24 KB (~6K tokens) into the top-level transcript.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(BUDGET_BYTES + 1024);
		expect(text).toContain("source of truth");
		expect(text).toMatch(new RegExp(`${bigFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+-\\d+`));
	});

	it("F1 — an explicitly requested oversized range must be bounded, not copied to an artifact", async () => {
		const result = await readTool.execute(
			"c2",
			{ path: `${bigFile}:1-900`, i: "read" },
			undefined,
			undefined,
			mainContext(),
		);
		const text = modelText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(BUDGET_BYTES + 1024);
		// Pre-fix: exceeding the 50 KB spill threshold duplicates the repo file
		// into session storage instead of returning a selector.
		expect(sessionManager.saved.size).toBe(0);
	});

	it("F4/F7 — a large generated result must be bounded well below the 50 KB spill threshold", async () => {
		const full = bulkText(400, "generated");
		const generator: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text", text: full }] }),
		} as unknown as AgentTool;
		const wrapped = wrapToolWithMetaNotice(generator);

		const result = await wrapped.execute("c3", {}, undefined, undefined, mainContext());
		const text = modelText(result);

		// Pre-fix: 32 KB < 50 KB threshold, so the whole blob enters context verbatim.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(BUDGET_BYTES + 512);
		expect(text).toContain("artifact://");
	});

	it("F6 — a large structured payload must be replaced by a valid compact envelope", async () => {
		const full = JSON.stringify(
			{ rootCause: "x", findings: Array.from({ length: 400 }, (_, i) => ({ i, note: "detail ".repeat(10) })) },
			null,
			2,
		);
		const structuredTool: AgentTool = {
			name: "task",
			label: "Task",
			description: "",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text", text: full }] }),
		} as unknown as AgentTool;
		const wrapped = wrapToolWithMetaNotice(structuredTool);

		const result = await wrapped.execute("c4", {}, undefined, undefined, mainContext());
		const text = modelText(result);

		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(BUDGET_BYTES + 512);
		const parsed = JSON.parse(text);
		expect(parsed.ompIngress).toBe("structured-output-externalized");
	});

	it("F9 — a subagent must keep the same oversized read unbounded", async () => {
		const subContext = {
			agentKind: "sub",
			settings: Settings.isolated(),
			sessionManager,
		} as unknown as AgentToolContext;
		const result = await readTool.execute("c5", { path: bigFile, i: "read" }, undefined, undefined, subContext);

		// This one is expected to PASS pre-fix: it pins the behavior the fix must
		// NOT change, so a regression that bounds workers too is visible.
		expect(Buffer.byteLength(modelText(result), "utf-8")).toBeGreaterThan(BUDGET_BYTES);
	});
});
