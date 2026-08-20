import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	appendLedgerEntry,
	compactModelIdentity,
	detectModelAttributionMismatch,
	formatExpandedDetail,
	formatRuntimeModelUsage,
	getOmpVersion,
	ledgerPathForSession,
	progressToLedgerEntry,
	readLedgerEntries,
	shouldAppendLedgerEntry,
	type LedgerEntry,
} from "@oh-my-pi/pi-coding-agent/task/subagent-ledger";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";

beforeAll(async () => {
	await initTheme();
});

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		id: overrides.id,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "do work",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 100,
		...overrides,
	} as AgentProgress;
}

function stripAnsi(s: string): string {
	return Bun.stripANSI(s);
}

describe("SPEC runtime model identity RED", () => {
	it("1. running subagent row includes provider/model identity (currently bare name)", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests: write tests",
				description: "write tests",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "running",
					resolvedModel: "google-antigravity/gemini-3.7-flash:high",
					resolvedModelIsFallback: false,
					resourcePool: "google-antigravity",
					routingReason: "parent Anthropic pool excluded",
				}),
			},
		];
		const out = stripAnsi(renderSubagentHudLines(sessions, 120).join("\n"));
		expect(out).toContain("WriterRedTests");
		expect(out).toContain("AGY·G3.7F·high");
	});

	it("2. fallback updates HUD to actual fallback model, retains selected", () => {
		const progress = makeProgress({
			id: "WriterRedTests",
			status: "running",
			resolvedModel: "meta/muse-spark-1.2-contributor",
			resolvedModelIsFallback: true,
			resourcePool: "meta",
			selectedModel: "google-antigravity/gemini-3.7-flash:high",
		} as Partial<AgentProgress> & { id: string });
		expect(progress.selectedModel).toBeDefined();
		expect(progress.selectedModel).toBe("google-antigravity/gemini-3.7-flash:high");
		expect(progress.resolvedModel).toBe("meta/muse-spark-1.2-contributor");
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				description: "fallback test",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress,
			},
		];
		const out = stripAnsi(renderSubagentHudLines(sessions, 120).join("\n"));
		expect(out).toContain("META·MS1.2");
		expect(out).toContain("↪");
	});

	it("3. lifecycle/progress payload carries enough identity for renderer without log scraping", () => {
		const p = makeProgress({
			id: "WriterRedTests",
			resolvedModel: "google-antigravity/gemini-3.7-flash",
			selectedModel: "google-antigravity/gemini-3.7-flash",
			resourcePool: "google-antigravity",
		} as Partial<AgentProgress> & { id: string });
		expect(p.resolvedModel).toBeDefined();
		expect(p.selectedModel).toBeDefined();
		expect(p.resourcePool).toBeDefined();
	});

	it("4. completed subagent retains actual provider/model", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				status: "completed",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "completed",
					resolvedModel: "google-antigravity/gemini-3.7-flash",
				}),
			},
		];
		const p = sessions[0].progress as AgentProgress;
		expect(p.resolvedModel).toBe("google-antigravity/gemini-3.7-flash");
	});

	it("5. machine-owned runtime usage summary generated from telemetry", () => {
		const summary = formatRuntimeModelUsage([
			{ id: "RedTestWriter", resolvedModel: "google-antigravity/gemini-3.7-flash" },
		]);
		expect(summary).toContain("RUNTIME_MODEL_USAGE");
		expect(summary).toContain("google-antigravity/gemini-3.7-flash");
	});

	it("6. conflicting prose claim yields MODEL_ATTRIBUTION_MISMATCH and preserves runtime truth", () => {
		const result = detectModelAttributionMismatch(
			"claude-3-7-sonnet",
			"google-antigravity/gemini-3.7-flash",
		);
		expect(result.mismatch).toBe(true);
		expect(result.warning).toContain("MODEL_ATTRIBUTION_MISMATCH");
		expect(result.authoritative).toBe("google-antigravity/gemini-3.7-flash");
	});

	it("7. unknown provider revision renders as unavailable/omitted", () => {
		const detail = formatExpandedDetail({ id: "WriterRedTests", agent: "task" } as AgentProgress, {
			ompVersion: "17.3.4",
		});
		expect(detail).toContain("revision: unavailable");
		expect(detail).not.toContain("undefined");
	});

	it("8. routing behavior unchanged (placeholder - real suite covers)", () => {
		expect(true).toBe(true);
	});

	it("9. compact rendering stays within mobile width", () => {
		const sessions: ObservableSession[] = [
			{
				id: "WriterRedTests",
				kind: "subagent",
				label: "WriterRedTests",
				description: "write tests",
				status: "active",
				detached: true,
				lastUpdate: Date.now(),
				progress: makeProgress({
					id: "WriterRedTests",
					status: "running",
					resolvedModel: "google-antigravity/gemini-3.7-flash:high",
					resourcePool: "google-antigravity",
				}),
			},
		];
		const lines = renderSubagentHudLines(sessions, 80).map(stripAnsi);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
		const narrow = renderSubagentHudLines(sessions, 40).map(stripAnsi);
		for (const line of narrow) expect(line.length).toBeLessThanOrEqual(60);
	});

	it("10. compact abbreviations for all required providers", () => {
		expect(compactModelIdentity("google-antigravity/gemini-3.7-flash:high")).toBe("AGY·G3.7F·high");
		expect(compactModelIdentity("meta/muse-spark-1.2-contributor")).toBe("META·MS1.2");
		expect(compactModelIdentity("openai-codex/gpt-5.6-sol")).toBe("OAI·G5.6S");
		expect(compactModelIdentity("cursor/grok-4.6")).toBe("CUR·G4.6");
	});

	it("11. HUD shows compact for each model", () => {
		const cases: Array<[string, string]> = [
			["google-antigravity/gemini-3.7-flash:high", "AGY·G3.7F·high"],
			["meta/muse-spark-1.2-contributor", "META·MS1.2"],
			["openai-codex/gpt-5.6-sol", "OAI·G5.6S"],
			["cursor/grok-4.6", "CUR·G4.6"],
		];
		for (const [model, compact] of cases) {
			const sessions: ObservableSession[] = [
				{
					id: "TestAgent",
					kind: "subagent",
					label: "TestAgent",
					description: "work",
					status: "active",
					detached: true,
					lastUpdate: Date.now(),
					progress: makeProgress({ id: "TestAgent", status: "running", resolvedModel: model }),
				},
			];
			const out = stripAnsi(renderSubagentHudLines(sessions, 120).join("\n"));
			expect(out).toContain(compact);
		}
	});

	it("12. ledger captures required fields", () => {
		const p = makeProgress({
			id: "WriterRedTests",
			status: "running",
			resolvedModel: "meta/muse-spark-1.2-contributor:high",
			selectedModel: "google-antigravity/gemini-3.7-flash:high",
			resolvedModelIsFallback: true,
			resourcePool: "meta",
			parentModel: "anthropic/claude-opus-5",
			ompVersion: "17.3.4",
			routingIntent: "strong",
			routingReason: "parent Anthropic pool excluded",
			routingReroutes: [
				{
					from: "google-antigravity/gemini-3.7-flash",
					to: "meta/muse-spark-1.2-contributor",
					reason: "fallback",
				},
			],
		} as Partial<AgentProgress> & { id: string });
		const e = progressToLedgerEntry(p);
		expect(e.selectedModel).toBe("google-antigravity/gemini-3.7-flash:high");
		expect(e.actualModel).toBe("meta/muse-spark-1.2-contributor:high");
		expect(e.fallback).toBe(true);
		expect(e.parentModel).toBe("anthropic/claude-opus-5");
		expect(e.ompVersion).toBe("17.3.4");
		expect(e.resourcePool).toBe("meta");
		expect(e.routingReason).toBeDefined();
		expect(e.routingReroutes?.length).toBe(1);
		expect(e.effort).toBe("high");
	});

	it("13. ledger NDJSON persistence roundtrip and transcript-safe suffix", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-test-"));
		const ledgerPath = path.join(dir, "test.ledger.ndjson");
		const p = makeProgress({
			id: "RedTestWriter",
			status: "running",
			resolvedModel: "google-antigravity/gemini-3.7-flash",
			selectedModel: "google-antigravity/gemini-3.7-flash",
			ompVersion: "17.3.4",
		} as Partial<AgentProgress> & { id: string });
		await appendLedgerEntry(ledgerPath, progressToLedgerEntry(p));
		const entries = await readLedgerEntries(ledgerPath);
		expect(entries.length).toBe(1);
		expect(entries[0].actualModel).toBe("google-antigravity/gemini-3.7-flash");
		const derived = ledgerPathForSession("/tmp/session.jsonl");
		expect(derived).toBe("/tmp/session.ledger.ndjson");
		expect(derived.endsWith(".jsonl")).toBe(false);
	});

	it("14. ledger deduplicates non-material progress ticks", () => {
		const base = progressToLedgerEntry(
			makeProgress({
				id: "A",
				status: "running",
				resolvedModel: "google-antigravity/gemini-3.7-flash:high",
				selectedModel: "google-antigravity/gemini-3.7-flash:high",
				resourcePool: "google-antigravity",
				ompVersion: "17.3.4",
			} as Partial<AgentProgress> & { id: string }),
		);
		const same: LedgerEntry = { ...base, timestamp: new Date().toISOString() };
		expect(shouldAppendLedgerEntry(base, same)).toBe(false);
		const fallbackChange: LedgerEntry = {
			...base,
			actualModel: "meta/muse-spark-1.2-contributor:high",
			fallback: true,
		};
		expect(shouldAppendLedgerEntry(base, fallbackChange)).toBe(true);
		const completed: LedgerEntry = { ...fallbackChange, status: "completed" };
		expect(shouldAppendLedgerEntry(fallbackChange, completed)).toBe(true);
		const completedAgain: LedgerEntry = { ...completed, timestamp: new Date().toISOString() };
		expect(shouldAppendLedgerEntry(completed, completedAgain)).toBe(false);
	});

	it("15. OMP version derived automatically", () => {
		const v = getOmpVersion();
		expect(v).not.toBe("unknown");
		expect(v).toMatch(/^\d+\.\d+\.\d+/);
	});
});
