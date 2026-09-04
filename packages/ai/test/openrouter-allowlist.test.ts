import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	assertOpenRouterAllowlisted,
	assertOpenRouterSelectorAllowlisted,
	CANONICAL_OPENROUTER_ALLOWLIST_PATH,
	formatOpenRouterSelector,
	isValidApprovedOpenRouterSelector,
	loadApprovedOpenRouterSelectors,
	parseOpenRouterAllowlistPolicy,
} from "@oh-my-pi/pi-ai/openrouter-allowlist";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	installOpenRouterAllowlistTestPolicy,
	withOpenRouterAllowlistTestPolicyPath,
	writeOpenRouterAllowlistPolicyFile,
} from "./openrouter-allowlist-test-helpers";

const context: Context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function openRouterModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

function codexModel(): Model<Api> {
	return buildModel({
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	});
}

describe("openrouter allowlist", () => {
	let cleanupTestPolicy: (() => void) | undefined;
	let tempDir: string | undefined;

	afterEach(() => {
		cleanupTestPolicy?.();
		cleanupTestPolicy = undefined;
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function usePolicy(contents: unknown): void {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		const policyPath = writeOpenRouterAllowlistPolicyFile(tempDir, contents);
		cleanupTestPolicy = withOpenRouterAllowlistTestPolicyPath(policyPath);
	}

	it("uses the fixed canonical production policy path", () => {
		expect(CANONICAL_OPENROUTER_ALLOWLIST_PATH).toBe("/home/chris/.config/cp7/openrouter-allowlist.json");
	});

	it("formats selectors as provider/id", () => {
		expect(formatOpenRouterSelector("openrouter", "z-ai/glm-5.3-flash")).toBe("openrouter/z-ai/glm-5.3-flash");
	});

	it("validates approved selector entries strictly", () => {
		expect(isValidApprovedOpenRouterSelector("openrouter/z-ai/glm-5.3-flash")).toBe(true);
		for (const entry of [
			"",
			"openrouter/",
			"openrouter",
			" z-ai/glm-5.3-flash",
			"openrouter/z-ai/glm-5.3-flash ",
			"anthropic/claude-sonnet-5",
		]) {
			expect(isValidApprovedOpenRouterSelector(entry)).toBe(false);
		}
	});

	it("parses empty deny-all policy", () => {
		expect(parseOpenRouterAllowlistPolicy(JSON.stringify({ schema_version: 1, approved_models: [] }))).toEqual(
			new Set(),
		);
	});

	it("rejects duplicate and whitespace-invalid policy entries", () => {
		expect(
			parseOpenRouterAllowlistPolicy(
				JSON.stringify({
					schema_version: 1,
					approved_models: ["openrouter/z-ai/glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash"],
				}),
			),
		).toBeNull();
		expect(
			parseOpenRouterAllowlistPolicy(
				JSON.stringify({ schema_version: 1, approved_models: [" openrouter/z-ai/glm-5.3-flash"] }),
			),
		).toBeNull();
	});

	it("denies Terra before dispatch", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("openai/gpt-5.6-terra"))).toThrow(
			/openrouter\/openai\/gpt-5\.6-terra/,
		);
		expect(() => stream(openRouterModel("openai/gpt-5.6-terra"), context)).toThrow(AIError.ConfigurationError);
	});

	it("denies unrelated unapproved OpenRouter selectors", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("anthropic/claude-sonnet-5"))).toThrow(
			/openrouter\/anthropic\/claude-sonnet-5/,
		);
	});

	it("accepts the approved GLM selector", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).not.toThrow();
	});

	it("rejects similar-but-not-exact selectors", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		for (const id of [
			"z-ai/glm-5.3-flash:batch",
			"z-ai/glm-5.3-flash:free",
			"Z-AI/GLM-5.3-FLASH",
			" z-ai/glm-5.3-flash",
			"z-ai/glm-5.3-flash ",
			"glm-5.3-flash",
		]) {
			expect(() => assertOpenRouterAllowlisted(openRouterModel(id))).toThrow(AIError.ConfigurationError);
		}
	});

	it("denies all OpenRouter models when the policy file is missing", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		cleanupTestPolicy = withOpenRouterAllowlistTestPolicyPath(path.join(tempDir, "missing.json"));
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).toThrow(
			AIError.ConfigurationError,
		);
	});

	it("denies all OpenRouter models when the policy file is malformed", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		const policyPath = path.join(tempDir, "openrouter-allowlist.json");
		fs.writeFileSync(policyPath, "{ not-json");
		cleanupTestPolicy = withOpenRouterAllowlistTestPolicyPath(policyPath);
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).toThrow(
			AIError.ConfigurationError,
		);
	});

	it("denies all OpenRouter models when the schema version is unsupported", () => {
		usePolicy({ schema_version: 2, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).toThrow(
			AIError.ConfigurationError,
		);
	});

	it("denies all OpenRouter models for empty deny-all policy", () => {
		usePolicy({ schema_version: 1, approved_models: [] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).toThrow(
			AIError.ConfigurationError,
		);
	});

	it("leaves non-OpenRouter subscription selectors unaffected", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(codexModel())).not.toThrow();
		expect(() => stream(codexModel(), context)).toThrow(AIError.MissingApiKeyError);
	});

	it("enforces the allowlist on streamSimple before credential lookup", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => streamSimple(openRouterModel("openai/gpt-5.6-terra"), context)).toThrow(AIError.ConfigurationError);
	});

	it("denies unapproved requestModelId even when primary id is approved", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		const sneakyModel = {
			...openRouterModel("z-ai/glm-5.3-flash"),
			requestModelId: "openai/gpt-5.6-terra",
		};
		expect(() => assertOpenRouterAllowlisted(sneakyModel)).toThrow(/openrouter\/openai\/gpt-5\.6-terra/);
	});

	it("accepts models with pre-prefixed openrouter/ selector without double-prefixing", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(openRouterModel("openrouter/z-ai/glm-5.3-flash"))).not.toThrow();
	});

	it("checks selectors with pure helpers without mutating production enforcement", () => {
		const approved = new Set(["openrouter/custom/model"]);
		expect(() =>
			assertOpenRouterSelectorAllowlisted("openrouter/custom/model", approved, "/tmp/policy.json"),
		).not.toThrow();
		expect(() =>
			assertOpenRouterSelectorAllowlisted("openrouter/z-ai/glm-5.3-flash", approved, "/tmp/policy.json"),
		).toThrow(AIError.ConfigurationError);
	});

	it("loads approved selectors from an explicit path via pure loader", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		const policyPath = writeOpenRouterAllowlistPolicyFile(tempDir, {
			schema_version: 1,
			approved_models: ["openrouter/z-ai/glm-5.3-flash"],
		});
		expect(loadApprovedOpenRouterSelectors(policyPath)).toEqual(new Set(["openrouter/z-ai/glm-5.3-flash"]));
	});

	it("uses test-mode policy path without affecting production path constant", () => {
		cleanupTestPolicy = installOpenRouterAllowlistTestPolicy(["openrouter/z-ai/glm-5.3-flash"]);
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).not.toThrow();
		expect(CANONICAL_OPENROUTER_ALLOWLIST_PATH).toBe("/home/chris/.config/cp7/openrouter-allowlist.json");
	});
});
