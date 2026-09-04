import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
