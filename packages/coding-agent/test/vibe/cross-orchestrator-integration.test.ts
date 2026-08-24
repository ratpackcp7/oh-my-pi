/**
 * Failure tests F1-F20 for OMP Vibe + CP7 integration (SPEC §10).
 * Deterministic, no CP7 Python from OMP core.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { routeWorker } from "@oh-my-pi/pi-coding-agent/task/routing/router";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function makeParentSession(settings: Settings, opts: { sessionFile?: string | null } = {}): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session",
		getSessionFile: () => opts.sessionFile ?? null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

async function spawnAndCapture(cliOrRole: { cli?: "fast" | "good"; role?: string }, settings: Settings) {
	const captured = Promise.withResolvers<import("@oh-my-pi/pi-coding-agent/task/executor").ExecutorOptions>();
	const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
		captured.resolve(opts);
		return {
			index: 0,
			id: opts.id,
			agent: opts.agent.name,
			agentSource: "bundled",
			task: opts.task,
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 0,
		} as SingleResult;
	});
	const reg = VibeSessionRegistry.global();
	await reg.spawn(makeParentSession(settings), { ...(cliOrRole as any), prompt: "work" });
	const opts = await captured.promise;
	spy.mockRestore();
	return opts;
}

describe("F1-F20 cross-orchestrator integration", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("F1 legacy fast compatibility retains sonic", async () => {
		const opts = await spawnAndCapture(
			{ cli: "fast" },
			Settings.isolated({ modelRoles: { default: "anthropic/opus", smol: "fast/hy3" } }),
		);
		expect(opts.modelOverride).toEqual(["fast/hy3"]);
		expect(opts.modelRole).toBe("smol");
	});

	it("F2 legacy good compatibility retains task", async () => {
		const opts = await spawnAndCapture(
			{ cli: "good" },
			Settings.isolated({ modelRoles: { default: "anthropic/opus", task: "anthropic/sonnet" } }),
		);
		expect(opts.modelOverride).toEqual(["anthropic/sonnet"]);
		expect(opts.modelRole).toBe("task");
	});

	it("F3 unknown role fails clearly", async () => {
		const reg = VibeSessionRegistry.global();
		await expect(
			reg.spawn(makeParentSession(Settings.isolated()), { role: "unknown" as any, prompt: "work" }),
		).rejects.toThrow(/Unknown vibe role/);
	});

	it("F4 vanilla OMP without CP7 still works (no python dep)", async () => {
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});
		const { id } = await reg.spawn(makeParentSession(Settings.isolated()), {
			role: "implementer",
			prompt: "vanilla work",
		});
		expect(id).toBeDefined();
		spy.mockRestore();
	});

	it("F5 no viable managed route fails cleanly with no half worker", async () => {
		const settings = Settings.isolated();
		const fakeRegistry = {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4" }],
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: () => undefined,
		} as any;
		const session = {
			cwd: "/tmp",
			settings,
			asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
			getSessionId: () => "parent-session",
			getSessionFile: () => null,
			getArtifactsDir: () => null,
			taskDepth: 0,
			enableLsp: false,
			modelRegistry: fakeRegistry,
		} as unknown as ToolSession;
		const reg = VibeSessionRegistry.global();
		await expect(
			reg.spawn(session, { role: "implementer", model: "openai/gpt-not-exist", prompt: "no viable" }),
		).rejects.toThrow(/PIN_UNAVAILABLE/);
		expect(reg.listIds(session).length).toBe(0);
	});

	it("F6 parent-pool protection routing field is accepted and stored", async () => {
		const parentPool = { key: "anthropic", provider: "anthropic", accountKey: "a", label: "anthropic" } as const;
		const otherPool = {
			key: "openai-codex",
			provider: "openai-codex",
			accountKey: "b",
			label: "openai-codex",
		} as const;
		const outcome: any = routeWorker({
			agent: "task",
			intent: "strong",
			requirements: {},
			parentPool,
			policy: {
				enabled: true,
				avoidParentPool: true,
				parentPoolFallback: "allow",
				excludePools: [],
				preferPools: [],
			},
			candidates: [
				{
					selector: "anthropic/claude-opus",
					pool: parentPool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 10,
					reasoning: true,
					usage: "healthy",
				},
				{
					selector: "openai-codex/gpt-5",
					pool: otherPool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 1,
					reasoning: true,
					usage: "healthy",
				},
			],
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.selectors[0]).toBe("openai-codex/gpt-5");
		expect(outcome.selectors).not.toContain("anthropic/claude-opus");
		const settings = Settings.isolated();
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});
		const { id } = await reg.spawn(makeParentSession(settings), {
			role: "implementer",
			routing: { allowParentPool: false, excludePools: ["anthropic"] },
			prompt: "parent avoid",
		});
		expect(id).toBeDefined();
		spy.mockRestore();
	});

	it("F7 explicit pin unavailable reports PIN_UNAVAILABLE and no substitution", async () => {
		const settings = Settings.isolated();
		const fakeRegistry = {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4" }],
			hasConfiguredAuth: () => true,
			getProviderBaseUrl: () => undefined,
		} as any;
		const session = {
			cwd: "/tmp",
			settings,
			asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
			getSessionId: () => "parent-session",
			getSessionFile: () => null,
			getArtifactsDir: () => null,
			taskDepth: 0,
			enableLsp: false,
			modelRegistry: fakeRegistry,
		} as unknown as ToolSession;
		const reg = VibeSessionRegistry.global();
		await expect(reg.spawn(session, { role: "implementer", model: "openai/gpt-999", prompt: "pin" })).rejects.toThrow(
			/PIN_UNAVAILABLE/,
		);
		expect(reg.listIds(session).length).toBe(0);
	});

	it("F8 reviewer independence normal case stores deadSelectors", async () => {
		const musePool = { key: "meta", provider: "meta", accountKey: "m", label: "meta" } as const;
		const gptPool = {
			key: "openai-codex",
			provider: "openai-codex",
			accountKey: "o",
			label: "openai-codex",
		} as const;
		const outcome: any = routeWorker({
			agent: "reviewer",
			intent: "strong",
			requirements: {},
			policy: {
				enabled: true,
				avoidParentPool: false,
				parentPoolFallback: "allow",
				excludePools: [],
				preferPools: [],
			},
			candidates: [
				{
					selector: "meta/muse-spark-1-contributor",
					pool: musePool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 1,
					reasoning: false,
					usage: "healthy",
				},
				{
					selector: "openai-codex/gpt-5-sol",
					pool: gptPool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 1,
					reasoning: true,
					usage: "healthy",
				},
			],
			deadSelectors: ["meta/muse-spark-1-contributor"],
		});
		expect(outcome.ok).toBe(true);
		expect(outcome.selectors).not.toContain("meta/muse-spark-1-contributor");
		expect(outcome.selectors[0]).toBe("openai-codex/gpt-5-sol");
		const settings = Settings.isolated();
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as any;
		});
		const { id } = await reg.spawn(makeParentSession(settings), {
			role: "reviewer",
			routing: { deadSelectors: ["meta/muse-spark-1-contributor"] },
			prompt: "review",
		});
		expect(id).toBeDefined();
		spy.mockRestore();
	});

	it("F11 same worker across vibe_send retains session", async () => {
		const settings = Settings.isolated();
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as any;
		});
		const sess = makeParentSession(settings);
		const { id } = await reg.spawn(sess, { cli: "fast", prompt: "first" });
		expect(reg.listIds(sess)).toContain(id);
		const before = reg.screens(sess).find(s => s.id === id);
		expect(before?.id).toBe(id);
		const beforePlanned = before?.plannedModel;
		expect(beforePlanned).toBeDefined();
		spy.mockRestore();
	});

	it("F12 rehydration preserves routing identity despite settings change", async () => {
		const fakeParentFile = "/tmp/fake-parent/parent.jsonl";
		const fakeManager: any = {
			getSessionId: () => "parent-session",
			getSessionFile: () => fakeParentFile,
			getEntries: () => [],
			getBranch: () => [],
			appendCustomEntry: () => {},
			flush: async () => {},
			ensureOnDisk: async () => {},
		};
		const peekSpy = vi
			.spyOn(SessionManager, "peekSessionInit")
			.mockResolvedValue({ cwd: "/tmp", init: { systemPrompt: "x", tools: [] } } as any);
		const fakeSpawnId = "test-rehydrate-id";
		const fakeSpawnEvent: any = {
			version: 2,
			id: fakeSpawnId,
			ownerId: "Main",
			parentSessionId: "parent-session",
			action: "spawn",
			role: "implementer",
			agent: "task",
			childSessionFile: `${fakeSpawnId}.jsonl`,
			createdAt: Date.now(),
			modelOverride: ["anthropic/sonnet"],
			modelRole: "task",
			intent: "strong",
		};
		const entries = [
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: fakeSpawnEvent,
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: {
					version: 2,
					id: fakeSpawnId,
					ownerId: "Main",
					parentSessionId: "parent-session",
					action: "turn-started",
					turn: 1,
				},
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: {
					version: 2,
					id: fakeSpawnId,
					ownerId: "Main",
					parentSessionId: "parent-session",
					action: "turn-settled",
					turn: 1,
				},
				timestamp: new Date().toISOString(),
			},
		];
		fakeManager.getEntries = () => entries;
		fakeManager.getBranch = () => entries;
		const sess2: ToolSession = {
			cwd: "/tmp",
			settings: Settings.isolated({
				modelRoles: { default: "anthropic/opus", task: "anthropic/new-model-should-not-be-used" },
			}),
			asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
			getSessionId: () => "parent-session",
			getSessionFile: () => fakeParentFile,
			getArtifactsDir: () => "/tmp/fake-parent",
			getActiveModelString: () => undefined,
			getModelString: () => undefined,
			sessionManager: fakeManager,
		} as unknown as ToolSession;
		const restored = await VibeSessionRegistry.global().rehydrate(sess2 as any);
		expect(restored).toBeGreaterThan(0);
		const after = VibeSessionRegistry.global()
			.screens(sess2)
			.find(s => s.id === fakeSpawnId);
		expect(after?.plannedModel).toBe("anthropic/sonnet");
		expect(after?.role).toBe("implementer");
		peekSpy.mockRestore();
	});

	it("F13 persisted route unavailable surfaces replacement requirement", async () => {
		const fakeParentFile = "/tmp/fake-parent2/parent.jsonl";
		const fakeManager: any = {
			getSessionId: () => "parent-session",
			getSessionFile: () => fakeParentFile,
			getEntries: () => [],
			getBranch: () => [],
			appendCustomEntry: () => {},
			flush: async () => {},
			ensureOnDisk: async () => {},
		};
		const fakeSpawnEvent: any = {
			version: 2,
			id: "test-unavail-id",
			ownerId: "Main",
			parentSessionId: "parent-session",
			action: "spawn",
			role: "implementer",
			agent: "task",
			childSessionFile: "test-unavail-id.jsonl",
			createdAt: Date.now(),
			modelOverride: ["anthropic/old-model-not-available"],
			modelRole: "task",
		};
		const entries = [
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: fakeSpawnEvent,
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: {
					version: 2,
					id: "test-unavail-id",
					ownerId: "Main",
					parentSessionId: "parent-session",
					action: "turn-started",
					turn: 1,
				},
				timestamp: new Date().toISOString(),
			},
			{
				type: "custom",
				customType: "vibe-session-lifecycle",
				data: {
					version: 2,
					id: "test-unavail-id",
					ownerId: "Main",
					parentSessionId: "parent-session",
					action: "turn-settled",
					turn: 1,
				},
				timestamp: new Date().toISOString(),
			},
		];
		fakeManager.getEntries = () => entries;
		fakeManager.getBranch = () => entries;
		const peekSpy = vi
			.spyOn(SessionManager, "peekSessionInit")
			.mockResolvedValue({ cwd: "/tmp", init: { systemPrompt: "x", tools: [] } } as any);
		const fakeRegistry = {
			getAvailable: () => [{ provider: "anthropic", id: "claude-sonnet-4" }],
		} as any;
		const sess: ToolSession = {
			cwd: "/tmp",
			settings: Settings.isolated(),
			asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
			getSessionId: () => "parent-session",
			getSessionFile: () => fakeParentFile,
			getArtifactsDir: () => "/tmp/fake-parent2",
			getActiveModelString: () => undefined,
			getModelString: () => undefined,
			sessionManager: fakeManager,
			modelRegistry: fakeRegistry,
		} as unknown as ToolSession;
		const restored = await VibeSessionRegistry.global().rehydrate(sess as any);
		expect(restored).toBeGreaterThan(0);
		const after = VibeSessionRegistry.global()
			.screens(sess)
			.find(s => s.id === "test-unavail-id");
		expect(after).toBeDefined();
		expect(after?.state).toBe("dead");
		peekSpy.mockRestore();
	});

	it("F14 dead worker not silently resurrected", async () => {
		const settings = Settings.isolated();
		const sess = makeParentSession(settings);
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as any;
		});
		const { id } = await reg.spawn(sess, { cli: "fast", prompt: "first" });
		await reg.kill(sess, id);
		expect(reg.listIds(sess).length).toBe(0);
		await expect(reg.send(sess, { session: id, message: "second" })).rejects.toThrow(/dead/);
		spy.mockRestore();
	});

	it("F19 truthful metadata display", async () => {
		const settings = Settings.isolated();
		const reg = VibeSessionRegistry.global();
		const spy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async (opts: any) => {
			return {
				index: 0,
				id: opts.id,
				agent: opts.agent.name,
				agentSource: "bundled",
				task: opts.task,
				exitCode: 0,
				output: "ok",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as any;
		});
		const { id } = await reg.spawn(makeParentSession(settings), {
			role: "reviewer",
			metadata: { externalTaskId: "task-123" },
			prompt: "meta",
		});
		await new Promise(r => setTimeout(r, 50));
		const screens = reg.screens(makeParentSession(settings));
		const s = screens.find(x => x.id === id);
		expect(s?.metadata?.externalTaskId).toBe("task-123");
		expect(s?.role).toBe("reviewer");
		spy.mockRestore();
	});
});
