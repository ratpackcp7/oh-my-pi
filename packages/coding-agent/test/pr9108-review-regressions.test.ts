import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@oh-my-pi/pi-coding-agent/config/settings-schema";

const root = new URL("../src/", import.meta.url);
const readSource = async (relative: string) => Bun.file(new URL(relative, root)).text();

describe("PR #9108 review regressions", () => {
	it("keeps dynamic task routing opt-in by default", () => {
		expect(SETTINGS_SCHEMA["task.routing.enabled"].default).toBe(false);
	});

	it("keeps routing snapshot off provider usage/network probes", async () => {
		const source = await readSource("task/routing/snapshot.ts");
		expect(source).not.toContain("authStorage.getModelUsageHealth(");
		expect(source).toContain('usage: "unknown"');
	});

	it("keeps ledger persistence outside transcript discovery and uses static imports", async () => {
		const ledger = await readSource("task/subagent-ledger.ts");
		const executor = await readSource("task/executor.ts");
		expect(ledger).toContain(".ledger.ndjson");
		expect(ledger).not.toContain(".ledger.jsonl");
		expect(executor).not.toContain('await import("./subagent-ledger")');
		expect(executor).not.toContain('import("./subagent-ledger").LedgerEntry');
		expect(executor).toContain('logger.debug("Subagent ledger append failed"');
	});

	it("captures selected model before auth fallback", async () => {
		const source = await readSource("task/executor.ts");
		const selected = source.indexOf("const selectedResolution = resolveModelOverride(");
		const fallback = source.indexOf("resolveModelOverrideWithAuthFallback(");
		expect(selected).toBeGreaterThan(-1);
		expect(fallback).toBeGreaterThan(-1);
		expect(selected).toBeLessThan(fallback);
		expect(source).toContain("selectedResolution.explicitThinkingLevel");
	});

	it("does not persist sibling history before the batch failure gate", async () => {
		const source = await readSource("task/index.ts");
		const start = source.indexOf("const siblingPoolKeysForBatch");
		const failureGate = source.indexOf("if (preflightFailures.length > 0)", start);
		const beforeGate = source.slice(start, failureGate);
		expect(start).toBeGreaterThan(-1);
		expect(failureGate).toBeGreaterThan(start);
		expect(beforeGate).not.toContain("this.#siblingPoolKeys.push(poolKey)");
		expect(source.indexOf("this.#siblingPoolKeys.push(poolKey)", failureGate)).toBeGreaterThan(failureGate);
	});
});
