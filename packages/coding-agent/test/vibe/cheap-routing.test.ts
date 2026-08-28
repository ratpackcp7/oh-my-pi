/**
 * Vibe utility/scout cheap routing stays inside the @smol class.
 *
 * Covers the real chain: Vibe role → bundled agent → cheap intent → snapshot
 * candidate building (broad roster) → eligibility → planned model.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { VibeRole } from "@oh-my-pi/pi-coding-agent/vibe/lifecycle";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

const FLASH = "google-antigravity/gemini-3.1-flash-lite";
const GLM = "cerebras/zai-glm-4.7";
const GROK = "cursor/cursor-grok-4.6";
const GPT = "openai-codex/gpt-5.5";

function models() {
	return [
		{
			provider: "google-antigravity",
			id: "gemini-3.1-flash-lite",
			input: ["text"],
			supportsTools: true,
			contextWindow: 1_000_000,
			cost: { input: 0.05, output: 0.05 },
			reasoning: false,
			baseUrl: "https://agy.example",
		},
		{
			provider: "cerebras",
			id: "zai-glm-4.7",
			input: ["text"],
			supportsTools: true,
			contextWindow: 128_000,
			cost: { input: 0.1, output: 0.1 },
			reasoning: false,
			baseUrl: "https://cerebras.example",
		},
		{
			provider: "openai-codex",
			id: "gpt-5.5",
			input: ["text"],
			supportsTools: true,
			contextWindow: 200_000,
			cost: { input: 15, output: 15 },
			reasoning: true,
			baseUrl: "https://api.openai.com",
		},
		{
			provider: "cursor",
			id: "cursor-grok-4.6",
			input: ["text", "image"],
			supportsTools: true,
			contextWindow: 200_000,
			cost: { input: 20, output: 20 },
			reasoning: true,
			baseUrl: "https://api.cursor.com",
		},
	];
}

function makeParent(): ToolSession {
	const roster = models();
	const settings = Settings.isolated({
		modelRoles: { smol: GLM, default: GROK },
		"task.routing.enabled": true,
		"task.routing.avoidParentPool": false,
		"task.routing.parentPoolFallback": "allow",
		"task.routing.excludePools": [],
		"task.routing.preferPools": ["cursor"],
		"task.routing.workerModels": [FLASH, GLM, GPT, GROK],
		"retry.usageReservePct": 10,
	});
	const authStorage = {
		getOAuthAccountIdentity: () => undefined,
		getCredentialOrigin: () => ({ kind: "api_key" }),
		peekBrokerModelUsageHealth: (_provider: string, opts: { modelId: string }) => {
			if (opts.modelId === "cursor-grok-4.6" || opts.modelId === "gpt-5.5") {
				return {
					state: "healthy",
					accounts: [{ accountKey: "api-key", state: "healthy", remainingFraction: 1 }],
				};
			}
			return { state: "unknown", accounts: [] };
		},
	};
	const modelRegistry = {
		getAvailable: () => roster,
		hasConfiguredAuth: () => true,
		getProviderBaseUrl: (provider: string) => roster.find(model => model.provider === provider)?.baseUrl,
		authStorage,
	};
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-cheap-routing",
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
		authStorage,
		modelRegistry,
		getActiveModelString: () => GROK,
		getModelString: () => GROK,
	} as unknown as ToolSession;
}

async function spawnRole(role: VibeRole, extra: { model?: string } = {}) {
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(
		async opts =>
			({
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
			}) as SingleResult,
	);
	const parent = makeParent();
	const { id } = await VibeSessionRegistry.global().spawn(parent, { role, prompt: "work", ...extra });
	const screen = VibeSessionRegistry.global()
		.screens(parent)
		.find(entry => entry.id === id);
	return { id, screen, parent };
}

describe("vibe cheap routing contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("maps utility → sonic → cheap and stays inside the smol class despite premium headroom", async () => {
		const { screen } = await spawnRole("utility");
		expect(screen?.role).toBe("utility");
		expect(screen?.intent).toBe("cheap");
		const planned = screen?.plannedModel;
		expect(planned).toBeTruthy();
		if (!planned) throw new Error("expected plannedModel");
		expect([FLASH, GLM]).toContain(planned);
		expect(planned).not.toBe(GROK);
		expect(planned).not.toBe(GPT);
	});

	it("maps scout → scout → cheap through the same eligibility class", async () => {
		const { screen } = await spawnRole("scout");
		expect(screen?.role).toBe("scout");
		expect(screen?.intent).toBe("cheap");
		const planned = screen?.plannedModel;
		expect(planned).toBeTruthy();
		if (!planned) throw new Error("expected plannedModel");
		expect([FLASH, GLM]).toContain(planned);
		expect(planned).not.toBe(GROK);
		expect(planned).not.toBe(GPT);
	});

	it("honors an explicit premium pin on a cheap role without rewriting it through the cheap gate", async () => {
		const { screen } = await spawnRole("utility", { model: GROK });
		expect(screen?.role).toBe("utility");
		expect(screen?.plannedModel).toBe(GROK);
	});
});
