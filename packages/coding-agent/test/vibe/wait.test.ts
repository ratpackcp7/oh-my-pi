import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as executorModule from "../../src/task/executor";
import type { SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";
import { VibeWaitTool } from "../../src/tools/vibe";
import { VibeSessionRegistry } from "../../src/vibe/runtime";

const OWNER = "test-owner";
const WORKER = "test-worker";

interface TestTurn {
	jobId: string;
	complete: (text: string) => void;
}

let manager: AsyncJobManager;
let session: ToolSession;

function startTurn(options?: { onDelivery?: (jobId: string, text: string) => void }): TestTurn {
	const completion = Promise.withResolvers<string>();
	if (options?.onDelivery) {
		manager.registerDeliverySink(OWNER, options.onDelivery);
	}
	const jobId = manager.register(
		"task",
		"test vibe turn",
		async ({ signal }) => {
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(new Error("cancelled"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([completion.promise, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		{ ownerId: OWNER },
	);
	VibeSessionRegistry.global().registerRecordForTests({ id: WORKER, ownerId: OWNER, jobId });
	return { jobId, complete: completion.resolve };
}

function startTurnWithId(id: string, options?: { onDelivery?: (jobId: string, text: string) => void }): TestTurn {
	const completion = Promise.withResolvers<string>();
	if (options?.onDelivery) {
		manager.registerDeliverySink(OWNER, options.onDelivery);
	}
	const jobId = manager.register(
		"task",
		"test vibe turn",
		async ({ signal }) => {
			const aborted = Promise.withResolvers<never>();
			const onAbort = () => aborted.reject(new Error("cancelled"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([completion.promise, aborted.promise]);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		{ ownerId: OWNER },
	);
	VibeSessionRegistry.global().registerRecordForTests({ id, ownerId: OWNER, jobId });
	return { jobId, complete: completion.resolve };
}

function makeParentSessionForEnvelope(settings: Settings, mgr: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: mgr,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getAgentId: () => OWNER,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

beforeEach(() => {
	manager = new AsyncJobManager({});
	session = {
		getAgentId: () => OWNER,
		getSessionId: () => "test-parent-session",
		getSessionFile: () => null,
		asyncJobManager: manager,
	} as unknown as ToolSession;
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await manager.dispose({ timeoutMs: 100 });
	VibeSessionRegistry.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("vibe wait completion classification", () => {
	it("reports a true timer expiry as timed out", async () => {
		vi.useFakeTimers();
		startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 10 });
		vi.advanceTimersByTime(10);

		const outcome = await pending;

		expect(outcome.timedOut).toBe(true);
		expect(outcome.settled).toEqual([]);
		expect(outcome.stillRunning).toEqual([WORKER]);
	});

	it("returns a settled worker result instead of timing out", async () => {
		const turn = startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 1_000 });
		turn.complete("worker result");

		const outcome = await pending;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toEqual([
			{ id: WORKER, jobId: turn.jobId, status: "completed", resultText: "worker result" },
		]);
	});

	it("does not render an abort as an elapsed wait window, even with a long timeout", async () => {
		startTurn();
		const controller = new AbortController();
		controller.abort();

		const result = await new VibeWaitTool(session).execute("wait-call", { timeout: 900 }, controller.signal);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details?.wait?.timedOut).toBe(false);
		expect(text).toContain("Still running");
		expect(text).not.toContain("Wait window elapsed");
		expect(text).not.toContain("re-issue vibe_wait");
	});

	it("restores async self-delivery after an interrupted wait", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const turn = startTurn({ onDelivery: (jobId, text) => deliveries.push({ jobId, text }) });
		const controller = new AbortController();
		const pending = VibeSessionRegistry.global().wait(session, {
			timeoutMs: 1_000,
			signal: controller.signal,
		});
		controller.abort();

		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		turn.complete("delivered later");
		await manager.getJob(turn.jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 1_000 });

		expect(deliveries).toEqual([{ jobId: turn.jobId, text: "delivered later" }]);
	});

	it("returns a cancelled worker settlement without classifying it as timeout", async () => {
		const turn = startTurn();
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 1_000 });
		manager.cancel(turn.jobId, { ownerId: OWNER });

		const outcome = await pending;

		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled[0]).toMatchObject({ id: WORKER, jobId: turn.jobId, status: "cancelled" });
	});
});

describe("vibe wait envelope and deadman", () => {
	it("long-duration settle: worker settles after 60s exceeding old 30s default, wait returns immediately at settlement", async () => {
		vi.useFakeTimers();
		const turn = startTurn();
		// No explicit timeout => should use deadman (25m), not 30s default.
		const pending = VibeSessionRegistry.global().wait(session, {});
		// Advance 60s (exceeds old 30s). On old code this would have timed out already.
		// Schedule settlement at 60s.
		setTimeout(() => turn.complete("late result"), 60_000);
		vi.advanceTimersByTime(60_000);
		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toHaveLength(1);
		expect(outcome.settled[0].resultText).toBe("late result");
	});

	it("deadman expiry: no settlement before 25m ceiling returns stuck framing, job remains alive, subsequent wait continues", async () => {
		vi.useFakeTimers();
		const turn = startTurn();
		// Use tool-level to verify framing.
		const pendingTool = new VibeWaitTool(session).execute("wait-call", {}, new AbortController().signal);
		// Advance to just before deadman: 25m - 1s
		const DEADMAN_MS = 25 * 60 * 1000;
		vi.advanceTimersByTime(DEADMAN_MS - 1000);
		// Not yet timed out — create a check that pending hasn't resolved.
		let resolved = false;
		let result: Awaited<ReturnType<VibeWaitTool["execute"]>> | undefined;
		void pendingTool.then(r => {
			resolved = true;
			result = r;
		});
		await Promise.resolve();
		// Give microtasks a chance; should still be pending
		expect(resolved).toBe(false);
		// Advance past deadman
		vi.advanceTimersByTime(2000);
		result = await pendingTool;
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(result.details?.wait?.timedOut).toBe(true);
		expect(text).toContain("may be stuck");
		expect(text).not.toContain("Wait window elapsed");
		// Job remains alive
		expect(manager.getJob(turn.jobId)?.status).toBe("running");
		// Subsequent wait can continue watching and settles when worker completes
		const secondPending = VibeSessionRegistry.global().wait(session, { timeoutMs: 1000 });
		turn.complete("eventual result");
		const secondOutcome = await secondPending;
		expect(secondOutcome.timedOut).toBe(false);
		expect(secondOutcome.settled[0].resultText).toBe("eventual result");
	});

	it("mid-wait steering: abort fired while already blocked aborts promptly and not as timeout", async () => {
		vi.useFakeTimers();
		startTurn();
		const controller = new AbortController();
		const pending = VibeSessionRegistry.global().wait(session, { signal: controller.signal });
		// Abort after 100ms while blocked
		setTimeout(() => controller.abort(), 100);
		vi.advanceTimersByTime(100);
		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toEqual([]);
		// Also verify via tool
		const turn2 = startTurnWithId("mid-worker-2");
		const ctrl2 = new AbortController();
		const toolPending = new VibeWaitTool(session).execute("wait-call", {}, ctrl2.signal);
		setTimeout(() => ctrl2.abort(), 50);
		vi.advanceTimersByTime(50);
		const toolResult = await toolPending;
		const text = toolResult.content[0]?.type === "text" ? toolResult.content[0].text : "";
		expect(toolResult.details?.wait?.timedOut).toBe(false);
		expect(text).not.toContain("Wait window elapsed");
		expect(text).not.toContain("may be stuck");
		// Cleanup
		manager.cancel(turn2.jobId, { ownerId: OWNER });
	});

	it("early failure: worker fails shortly after starting returns immediately with failed status", async () => {
		vi.useFakeTimers();
		// Create a job that fails quickly
		const jobId = manager.register(
			"task",
			"failing vibe turn",
			async () => {
				await Promise.resolve();
				throw new Error("boom failure");
			},
			{ ownerId: OWNER },
		);
		VibeSessionRegistry.global().registerRecordForTests({ id: WORKER, ownerId: OWNER, jobId });
		const pending = VibeSessionRegistry.global().wait(session, {});
		// Failure should be immediate, not deadman delay
		vi.advanceTimersByTime(10);
		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toHaveLength(1);
		expect(outcome.settled[0].status).toBe("failed");
		expect(outcome.settled[0].resultText).toContain("boom failure");
	});

	it("two-worker race: A settles first, wait returns A immediately, B stays running", async () => {
		const turnA = startTurnWithId("worker-a");
		const turnB = startTurnWithId("worker-b");
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 5000 });
		turnA.complete("a result");
		const outcome = await pending;
		expect(outcome.timedOut).toBe(false);
		expect(outcome.settled).toHaveLength(1);
		expect(outcome.settled[0].id).toBe("worker-a");
		expect(outcome.stillRunning).toContain("worker-b");
		expect(manager.getJob(turnB.jobId)?.status).toBe("running");
		// B still recoverable — named wait for B watches only that worker and returns B after completion
		const second = VibeSessionRegistry.global().wait(session, { sessions: ["worker-b"], timeoutMs: 1000 });
		turnB.complete("b result");
		const secondOutcome = await second;
		expect(secondOutcome.settled[0].id).toBe("worker-b");
	});

	it("duplicate-suppression on settle: successful wait-delivered settlement does not duplicate async delivery", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const turn = startTurn({ onDelivery: (jobId, text) => deliveries.push({ jobId, text }) });
		const pending = VibeSessionRegistry.global().wait(session, { timeoutMs: 5000 });
		turn.complete("once result");
		const outcome = await pending;
		expect(outcome.settled).toHaveLength(1);
		// Allow any async delivery loop to attempt delivery
		await Promise.resolve();
		await manager.drainDeliveries({ timeoutMs: 200 });
		// Wait already acknowledged, so async sink should not have received duplicate
		expect(deliveries).toHaveLength(0);
	});

	it("compact envelope, success: large trace and output produces capped wait-delivered result with agent:// pointer", async () => {
		const settings = Settings.isolated({});
		const envelopeSession = makeParentSessionForEnvelope(settings, manager);
		// Build huge output (>6000) and many tool calls (>40)
		const hugeOutput = Array.from({ length: 800 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"); // ~ ~ > 15k
		const largeTraceCount = 50;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options: any) => {
			for (let i = 0; i < largeTraceCount; i++) {
				options.onProgress({
					index: 0,
					id: options.id,
					agent: options.agent.name,
					agentSource: "bundled",
					status: "running",
					task: options.task,
					recentTools: [{ tool: `tool_${i}`, args: `arg${i}`, endMs: Date.now() }],
					recentOutput: [`output chunk ${i}`],
					toolCount: i + 1,
					requests: i + 1,
					tokens: 0,
					cost: 0,
					durationMs: 100,
				});
			}
			return {
				index: 0,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: options.task,
				exitCode: 0,
				output: hugeOutput,
				stderr: "",
				truncated: false,
				durationMs: 1234,
				tokens: 0,
				requests: largeTraceCount,
				resolvedModel: "test/model",
			} as SingleResult;
		});
		const registry = VibeSessionRegistry.global();
		const spawn = await registry.spawn(envelopeSession, { cli: "fast", prompt: "do huge work" });
		// Wait for completion via vibe_wait
		const outcome = await registry.wait(envelopeSession, { timeoutMs: 5000 });
		expect(outcome.settled).toHaveLength(1);
		const text = outcome.settled[0].resultText;
		// Trace lines capped to 0-5 entries
		const traceLines = text.split("\n").filter(l => l.trim().startsWith("- "));
		// Extract only trace-ish lines (tool calls). Allow overflow line.
		const toolTraceLines = traceLines.filter(l => l.includes("tool_"));
		expect(toolTraceLines.length).toBeLessThanOrEqual(5);
		// Response preview capped to 2500-3000 (pick 2500). Current new cap is 2500, so ensure length of <response> content not huge.
		const responseMatch = text.match(/<response[^>]*>([\s\S]*?)<\/response>/);
		const responseContent = responseMatch?.[1] ?? "";
		expect(responseContent.length).toBeLessThanOrEqual(3000);
		// Full output NOT in trimmed text
		expect(text).not.toContain(hugeOutput);
		// Contains agent:// pointer for recovery
		expect(text).toContain(`agent://${spawn.id}`);
		// Contains status/model/duration
		expect(text).toContain("completed");
		expect(text).toContain("test/model");
	});

	it("compact envelope, async: same large fixture via async self-delivery is equally capped with pointer", async () => {
		const settings = Settings.isolated({});
		const envelopeSession = makeParentSessionForEnvelope(settings, manager);
		const hugeOutput = Array.from({ length: 800 }, (_, i) => `async line ${i} ${"y".repeat(20)}`).join("\n");
		const largeTraceCount = 50;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (options: any) => {
			for (let i = 0; i < largeTraceCount; i++) {
				options.onProgress({
					index: 0,
					id: options.id,
					agent: options.agent.name,
					agentSource: "bundled",
					status: "running",
					task: options.task,
					recentTools: [{ tool: `tool_${i}`, args: `arg${i}`, endMs: Date.now() }],
					recentOutput: [`async output ${i}`],
					toolCount: i + 1,
					requests: i + 1,
					tokens: 0,
					cost: 0,
					durationMs: 100,
				});
			}
			return {
				index: 0,
				id: options.id,
				agent: options.agent.name,
				agentSource: "bundled",
				task: options.task,
				exitCode: 0,
				output: hugeOutput,
				stderr: "",
				truncated: false,
				durationMs: 2345,
				tokens: 0,
				requests: largeTraceCount,
				resolvedModel: "test/model-async",
			} as SingleResult;
		});
		const deliveries: Array<{ jobId: string; text: string }> = [];
		manager.registerDeliverySink(OWNER, (jobId, text) => {
			deliveries.push({ jobId, text });
		});
		const registry = VibeSessionRegistry.global();
		const spawn = await registry.spawn(envelopeSession, { cli: "fast", prompt: "async huge work" });
		// Do NOT call wait; let async self-delivery happen
		await manager.getJob(spawn.jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 2000 });
		expect(deliveries).toHaveLength(1);
		const text = deliveries[0].text;
		const traceLines = text.split("\n").filter(l => l.trim().startsWith("- "));
		const toolTraceLines = traceLines.filter(l => l.includes("tool_"));
		expect(toolTraceLines.length).toBeLessThanOrEqual(5);
		const responseMatch = text.match(/<response[^>]*>([\s\S]*?)<\/response>/);
		const responseContent = responseMatch?.[1] ?? "";
		expect(responseContent.length).toBeLessThanOrEqual(3000);
		expect(text).not.toContain(hugeOutput);
		expect(text).toContain(`agent://${spawn.id}`);
		expect(text).toContain("completed");
	});
});
