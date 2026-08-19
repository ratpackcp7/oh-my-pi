import { describe, expect, it } from "bun:test";
import agentBridgeSource from "../src/eval/agent-bridge.ts" with { type: "text" };
import pythonRecoveryPrelude from "../src/eval/py/recovery.py" with { type: "text" };

function runPython(body: string): unknown {
	const preamble = `
import json
class _AwaitableList(list):
    def __await__(self):
        yield from ()
        return self
def _concurrency_limit():
    return 0
`;
	const proc = Bun.spawnSync(["python3", "-c", `${preamble}\n${pythonRecoveryPrelude}\n${body}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(proc.stderr));
	}
	return JSON.parse(new TextDecoder().decode(proc.stdout));
}

describe("eval runtime recovery", () => {
	it("preserves successful siblings when one parallel child fails", () => {
		const result = runPython(`
def boom():
    raise RuntimeError("socket lost")
try:
    parallel([lambda: "composer", boom, lambda: "agy"])
except ParallelFailure as exc:
    first = parallel.last()
    second = parallel.last()
    print(json.dumps({
        "message": str(exc),
        "first": first,
        "same": first == second,
    }))
`);
		expect(result).toEqual({
			message:
				"parallel() failed for indices [1]; completed indices [0, 2] are preserved in parallel.last(); retry only failed indices",
			first: {
				status: "failed",
				results: ["composer", null, "agy"],
				completed_indices: [0, 2],
				failed_indices: [1],
				errors: { "1": "RuntimeError: socket lost" },
			},
			same: true,
		});
	});

	it("replaces stale failure state after a later successful wave", () => {
		const result = runPython(`
def boom():
    raise RuntimeError("fail")
try:
    parallel([boom, lambda: 2])
except ParallelFailure:
    pass
parallel([lambda: "fresh"])
print(json.dumps(parallel.last()))
`);
		expect(result).toEqual({
			status: "completed",
			results: ["fresh"],
			completed_indices: [0],
			failed_indices: [],
			errors: {},
		});
	});

	it("keeps runtime-owned identity on Python agent handles", () => {
		const result = runPython(`
def _bridge_call(name, args):
    return {
        "text": "child says I am the wrong model",
        "details": {
            "id": "child-1",
            "agent": "task",
            "runtime_parent_provider": "anthropic",
            "runtime_parent_model": "anthropic/claude-opus-5",
            "runtime_parent_usage_pool": "anthropic\\0api\\0acct",
            "runtime_child_requested_model": "cursor/composer-2.5",
            "runtime_child_resolved_provider": "google-antigravity",
            "runtime_child_resolved_model": "google-antigravity/gemini-3.1-pro",
            "runtime_fallback_used": True,
        },
    }
node = agent("inspect", model="cursor/composer-2.5", handle=True)
print(json.dumps(node))
`);
		expect(result).toMatchObject({
			handle: "agent://child-1",
			runtime_parent_provider: "anthropic",
			runtime_parent_model: "anthropic/claude-opus-5",
			runtime_child_requested_model: "cursor/composer-2.5",
			runtime_child_resolved_provider: "google-antigravity",
			runtime_child_resolved_model: "google-antigravity/gemini-3.1-pro",
			runtime_fallback_used: true,
		});
	});
});

describe("eval runtime identity source", () => {
	it("derives identity from ToolSession and settled runtime result", () => {
		expect(agentBridgeSource).toContain("options.session.getActiveModelString?.() ?? options.session.getModelString?.()");
		expect(agentBridgeSource).toContain("resolveParentPoolIdentity(options.session)");
		expect(agentBridgeSource).toContain("const resolvedModel = result.resolvedModel");
		expect(agentBridgeSource).toContain("runtime_fallback_used: result.resolvedModelIsFallback === true");
		expect(agentBridgeSource).toContain("runtime_child_requested_model: parsed.model");
	});
});
