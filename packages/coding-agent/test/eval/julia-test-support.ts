import { $which } from "@oh-my-pi/pi-utils";
import { runBoundedProbe } from "../../src/eval/probe";

export const JULIA_PATH = $which("julia");
export const HAS_JULIA = Boolean(JULIA_PATH);

// The production availability probe hard-caps `julia -e "exit(0)"` at
// DEFAULT_PROBE_TIMEOUT_MS so a wedged interpreter cannot stall an agent turn
// (issue #9466), but tests that gate only on `$which` can see a legitimate cold
// Julia startup exceed that cap on a contended CI runner. Pay that cold start
// once under a test-infrastructure-only budget; subsequent executeJulia calls
// still use the normal production probe and its production timeout.
export const PREWARM_TIMEOUT_MS = 120_000;

export async function prewarmJulia(juliaPath: string): Promise<void> {
	// runBoundedProbe supplies stdio detachment and process-tree kill. juliaPath
	// may be a shim (for example juliaup), so the real interpreter must not
	// outlive the hook. timeoutCeilingMs is intentionally test-only here.
	const probe = await runBoundedProbe([juliaPath, "-e", "exit(0)"], {
		cwd: process.cwd(),
		env: process.env,
		timeoutMs: PREWARM_TIMEOUT_MS,
		timeoutCeilingMs: PREWARM_TIMEOUT_MS,
	});
	if (probe.timedOut) {
		throw new Error(
			`Julia prewarm (${juliaPath} -e 'exit(0)') timed out after ${PREWARM_TIMEOUT_MS}ms; the runner cannot start Julia at all`,
		);
	}
	if (probe.exitCode !== 0) {
		throw new Error(`Julia prewarm (${juliaPath} -e 'exit(0)') exited ${probe.exitCode}`);
	}
}
