import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { ExtractionClient } from "@oh-my-pi/pi-mnemopi/core/extraction/client";
import {
	installOpenRouterAllowlistTestPolicy,
	withOpenRouterAllowlistTestPolicyPath,
	writeOpenRouterAllowlistPolicyFile,
} from "../../ai/test/openrouter-allowlist-test-helpers";

const ENV_KEYS = [
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"MNEMOPI_EMBEDDINGS_VIA_API",
] as const;

function snapshotEnv(): Partial<Record<(typeof ENV_KEYS)[number], string>> {
	const snapshot: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) snapshot[key] = value;
	}
	return snapshot;
}

function restoreEnv(snapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

describe("openrouter allowlist mnemopi paths", () => {
	let cleanupPolicy: (() => void) | undefined;
	let tempDir: string | undefined;
	let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>>;

	afterEach(() => {
		cleanupPolicy?.();
		cleanupPolicy = undefined;
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
		restoreEnv(envSnapshot);
		resetEmbeddingProviderForTests();
	});

	function usePolicy(contents: unknown): void {
		envSnapshot = snapshotEnv();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopi-openrouter-allowlist-"));
		const policyPath = writeOpenRouterAllowlistPolicyFile(tempDir, contents);
		cleanupPolicy = withOpenRouterAllowlistTestPolicyPath(policyPath);
	}

	it("denies OpenRouter embeddings before network when model is unapproved", async () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		process.env.MNEMOPI_EMBEDDINGS_VIA_API = "1";
		process.env.MNEMOPI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
		process.env.MNEMOPI_EMBEDDING_API_URL = "https://openrouter.ai/api/v1";
		process.env.MNEMOPI_EMBEDDING_API_KEY = "sk-test";
		resetEmbeddingProviderForTests();

		let fetchCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as unknown as typeof fetch;

		try {
			await expect(embed(["hello"])).rejects.toThrow(ConfigurationError);
			expect(fetchCalled).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("allows approved OpenRouter embeddings through to fetch", async () => {
		cleanupPolicy = installOpenRouterAllowlistTestPolicy(["openrouter/openai/text-embedding-3-small"]);
		process.env.MNEMOPI_EMBEDDINGS_VIA_API = "1";
		process.env.MNEMOPI_EMBEDDING_MODEL = "openai/text-embedding-3-small";
		process.env.MNEMOPI_EMBEDDING_API_URL = "https://openrouter.ai/api/v1";
		process.env.MNEMOPI_EMBEDDING_API_KEY = "sk-test";
		resetEmbeddingProviderForTests();

		let fetchCalled = false;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			fetchCalled = true;
			return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const result = await embed(["hello"]);
			expect(fetchCalled).toBe(true);
			expect(result).not.toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("denies OpenRouter extraction chat before network for unapproved models", async () => {
		usePolicy({ schema_version: 1, approved_models: ["openrouter/z-ai/glm-5.3-flash"] });
		let fetchCalled = false;
		const client = new ExtractionClient({
			apiKey: "sk-test",
			baseUrl: "https://openrouter.ai/api/v1",
			model: "openai/gpt-5.6-terra",
			fetch: (async () => {
				fetchCalled = true;
				return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
			}) as FetchImpl,
		});

		await expect(client.callApi("openai/gpt-5.6-terra", [{ role: "user", content: "hi" }], 0, 128)).rejects.toThrow(
			ConfigurationError,
		);
		expect(fetchCalled).toBe(false);
	});
});
