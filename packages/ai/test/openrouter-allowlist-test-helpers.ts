import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OPENROUTER_ALLOWLIST_TEST_MODELS } from "./openrouter-allowlist-test-models";

let bootstrapPolicyPath: string | undefined;

/** Test-only seam: redirects allowlist reads when OMP_OPENROUTER_ALLOWLIST_TEST_MODE=1. */
export function installOpenRouterAllowlistTestPolicy(approvedModels: string[]): () => void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-"));
	const policyPath = path.join(dir, "openrouter-allowlist.json");
	fs.writeFileSync(policyPath, JSON.stringify({ schema_version: 1, approved_models: approvedModels }));
	const prevMode = process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE;
	const prevPath = process.env.OMP_OPENROUTER_ALLOWLIST_PATH;
	process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE = "1";
	process.env.OMP_OPENROUTER_ALLOWLIST_PATH = policyPath;
	return () => {
		if (prevMode === undefined) delete process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE;
		else process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE = prevMode;
		if (prevPath === undefined) delete process.env.OMP_OPENROUTER_ALLOWLIST_PATH;
		else process.env.OMP_OPENROUTER_ALLOWLIST_PATH = prevPath;
		fs.rmSync(dir, { recursive: true, force: true });
	};
}

export function writeOpenRouterAllowlistPolicyFile(dir: string, contents: unknown): string {
	const policyPath = path.join(dir, "openrouter-allowlist.json");
	fs.writeFileSync(policyPath, JSON.stringify(contents));
	return policyPath;
}

export function withOpenRouterAllowlistTestPolicyPath(policyPath: string): () => void {
	const prevMode = process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE;
	const prevPath = process.env.OMP_OPENROUTER_ALLOWLIST_PATH;
	process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE = "1";
	process.env.OMP_OPENROUTER_ALLOWLIST_PATH = policyPath;
	return () => {
		if (prevMode === undefined) delete process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE;
		else process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE = prevMode;
		if (prevPath === undefined) delete process.env.OMP_OPENROUTER_ALLOWLIST_PATH;
		else process.env.OMP_OPENROUTER_ALLOWLIST_PATH = prevPath;
	};
}

/**
 * Shared bun-test preload: provisions a temporary policy for mock/provider suites.
 * Idempotent within a process; production enforcement is unchanged outside test mode.
 */
export function bootstrapOpenRouterAllowlistTestPolicy(
	approvedModels: readonly string[] = OPENROUTER_ALLOWLIST_TEST_MODELS,
): void {
	if (process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE === "1" && process.env.OMP_OPENROUTER_ALLOWLIST_PATH) {
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-openrouter-allowlist-bootstrap-"));
	bootstrapPolicyPath = path.join(dir, "openrouter-allowlist.json");
	fs.writeFileSync(bootstrapPolicyPath, JSON.stringify({ schema_version: 1, approved_models: [...approvedModels] }));
	process.env.OMP_OPENROUTER_ALLOWLIST_TEST_MODE = "1";
	process.env.OMP_OPENROUTER_ALLOWLIST_PATH = bootstrapPolicyPath;
}
