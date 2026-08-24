/**
 * Director preference: role-oriented spawning is preferred when managed,
 * fast/good remain vanilla fallback. SPEC §8.2, §8.10, F1/F2/G3/G4.
 *
 * Proves:
 * 1. Prompt/tool surfaces teach implementer+reviewer as preferred managed path, not good twice.
 * 2. Managed implementer+reviewer workflow uses role names and reviewer resolves
 *    to a different family via deadSelectors; non-independent roles may reuse same family.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { routeWorker } from "@oh-my-pi/pi-coding-agent/task/routing/router";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

function makeParentSession(settings: Settings): ToolSession {
	return {
		cwd: "/tmp",
		settings,
		asyncJobManager: new AsyncJobManager({ onJobComplete: () => {} }),
		getSessionId: () => "parent-session-director-pref",
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
}

describe("director preference: role vs cli", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		VibeSessionRegistry.resetGlobalForTests();
	});

	it("prompt surfaces prefer implementer/reviewer roles, keep fast/good as fallback, no hard-coded model/CP7 paths", async () => {
		const repoRoot = path.resolve(import.meta.dir, "../..");
		const spawnMd = await fs.readFile(path.join(repoRoot, "src/prompts/tools/vibe-spawn.md"), "utf8");
		const modeMd = await fs.readFile(path.join(repoRoot, "src/prompts/system/vibe-mode-active.md"), "utf8");
		const listMd = await fs.readFile(path.join(repoRoot, "src/prompts/tools/vibe-list.md"), "utf8");
		const docsVibe = await fs.readFile(path.join(repoRoot, "../../docs/vibe-mode.md"), "utf8");

		for (const [name, text] of [
			["vibe-spawn.md", spawnMd],
			["vibe-mode-active.md", modeMd],
		] as const) {
			expect(text, `${name} should mention implementer`).toContain("implementer");
			expect(text, `${name} should mention reviewer`).toContain("reviewer");
			expect(text.toLowerCase(), `${name} should prefer role`).toMatch(/prefer.*role/);
			expect(text, `${name} should mention fast`).toContain("fast");
			expect(text, `${name} should mention good`).toContain("good");
			expect(text.toLowerCase(), `${name} should mark cli/fast/good as fallback/vanilla`).toMatch(
				/fallback|vanilla/,
			);
			expect(text, `${name} must not hard-code model IDs`).not.toMatch(
				/openai\/gpt-5|anthropic\/claude|google\/gemini/,
			);
			expect(text, `${name} must not contain CP7 paths`).not.toMatch(
				/cp7-agent-stack|\/home\/chris\/cp7-bridge|foreman\.py|orchestrator\.py/,
			);
		}

		expect(listMd).toContain("implementer");
		expect(listMd).toContain("reviewer");
		expect(docsVibe).toContain("vanilla fallback");
		expect(docsVibe).toContain("preferred when managed");
	});

	it("managed implementer+reviewer workflow uses role names, not good twice, and reviewer avoids implementer family", async () => {
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
				output: "done",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 0,
			} as SingleResult;
		});

		const { id: implId } = await reg.spawn(makeParentSession(settings), {
			role: "implementer",
			prompt: "implement feature X",
		} as any);
		const { id: revId } = await reg.spawn(makeParentSession(settings), {
			role: "reviewer",
			routing: { deadSelectors: ["task/imaginary-implementer-model"] },
			prompt: "review feature X",
		} as any);

		expect(implId).not.toBe(revId);

		const screens = reg.screens(makeParentSession(settings));
		const implScreen = screens.find(s => s.id === implId);
		const revScreen = screens.find(s => s.id === revId);
		expect(implScreen?.role).toBe("implementer");
		expect(revScreen?.role).toBe("reviewer");
		expect(implScreen?.cli).toBeUndefined();
		expect(revScreen?.cli).toBeUndefined();

		spy.mockRestore();

		const metaPool = { key: "meta", provider: "meta", accountKey: "m", label: "meta" } as const;
		const codexPool = {
			key: "openai-codex",
			provider: "openai-codex",
			accountKey: "o",
			label: "openai-codex",
		} as const;
		const implSelector = "meta/muse-spark-1";
		const result = routeWorker({
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
					selector: implSelector,
					pool: metaPool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 1,
					reasoning: false,
					usage: "healthy",
				},
				{
					selector: "openai-codex/gpt-5-reviewer",
					pool: codexPool,
					vision: false,
					supportsTools: true,
					contextWindow: null,
					costPerMTokenTotal: 1,
					reasoning: true,
					usage: "healthy",
				},
			],
			deadSelectors: [implSelector],
		}) as any;
		expect(result.ok).toBe(true);
		expect(result.selectors).not.toContain(implSelector);
		expect(result.selectors[0]).toBe("openai-codex/gpt-5-reviewer");
	});

	it("non-independent roles may reuse same model family without violation", async () => {
		const pool = { key: "anthropic", provider: "anthropic", accountKey: "a", label: "anthropic" } as const;
		const candidate = {
			selector: "anthropic/claude-opus",
			pool,
			vision: false,
			supportsTools: true,
			contextWindow: null,
			costPerMTokenTotal: 1,
			reasoning: true,
			usage: "healthy" as const,
		};
		const a = routeWorker({
			agent: "task",
			intent: "strong",
			requirements: {},
			policy: {
				enabled: true,
				avoidParentPool: false,
				parentPoolFallback: "allow",
				excludePools: [],
				preferPools: [],
			},
			candidates: [candidate],
		}) as any;
		const b = routeWorker({
			agent: "task",
			intent: "strong",
			requirements: {},
			policy: {
				enabled: true,
				avoidParentPool: false,
				parentPoolFallback: "allow",
				excludePools: [],
				preferPools: [],
			},
			candidates: [candidate],
		}) as any;
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(a.selectors[0]).toBe("anthropic/claude-opus");
		expect(b.selectors[0]).toBe("anthropic/claude-opus");
	});

	it("fast/good remain valid fallback (F1/F2 still pass)", async () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/opus", smol: "fast/hy3", task: "anthropic/sonnet" },
		});
		VibeSessionRegistry.resetGlobalForTests();
		await expect(
			VibeSessionRegistry.global().spawn(makeParentSession(settings), { cli: "fast", prompt: "fast2" } as any),
		).resolves.toBeDefined();
		VibeSessionRegistry.resetGlobalForTests();
		await expect(
			VibeSessionRegistry.global().spawn(makeParentSession(settings), { cli: "good", prompt: "good2" } as any),
		).resolves.toBeDefined();
	});
});
