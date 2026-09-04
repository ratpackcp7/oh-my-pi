import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	__openRouterAllowlistForTesting,
	assertOpenRouterAllowlisted,
	formatOpenRouterSelector,
} from "@oh-my-pi/pi-ai/openrouter-allowlist";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

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

function writePolicy(dir: string, contents: unknown): string {
	const policyPath = path.join(dir, "openrouter-allowlist.json");
	fs.writeFileSync(policyPath, JSON.stringify(contents));
	return policyPath;
}

describe("openrouter allowlist", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		__openRouterAllowlistForTesting.setPolicyPath(undefined);
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	function usePolicy(contents: unknown): void {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		__openRouterAllowlistForTesting.setPolicyPath(writePolicy(tempDir, contents));
	}

	it("formats selectors as provider/id", () => {
		expect(formatOpenRouterSelector("openrouter", "z-ai/glm-5.3-flash")).toBe("openrouter/z-ai/glm-5.3-flash");
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
		__openRouterAllowlistForTesting.setPolicyPath(path.join(tempDir, "missing.json"));
		expect(() => assertOpenRouterAllowlisted(openRouterModel("z-ai/glm-5.3-flash"))).toThrow(
			AIError.ConfigurationError,
		);
	});

	it("denies all OpenRouter models when the policy file is malformed", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
		const policyPath = path.join(tempDir, "openrouter-allowlist.json");
		fs.writeFileSync(policyPath, "{ not-json");
		__openRouterAllowlistForTesting.setPolicyPath(policyPath);
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

	it("leaves non-OpenRouter subscription selectors unaffected", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => assertOpenRouterAllowlisted(codexModel())).not.toThrow();
		expect(() => stream(codexModel(), context)).toThrow(AIError.MissingApiKeyError);
	});

	it("enforces the allowlist on streamSimple before credential lookup", () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		expect(() => streamSimple(openRouterModel("openai/gpt-5.6-terra"), context)).toThrow(AIError.ConfigurationError);
	});
});
