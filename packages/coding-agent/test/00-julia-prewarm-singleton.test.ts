import { test } from "bun:test";
import { HAS_JULIA, JULIA_PATH, PREWARM_TIMEOUT_MS, prewarmJulia } from "./eval/julia-test-support";

// The singleton/global-state CI bucket is one serial Bun invocation and its
// explicit file list is sorted. Keep this canary first so fork-specific Julia
// integration tests do not mistake a cold, contended startup for an unusable
// interpreter. Production availability remains capped by the normal 10s probe.
test.skipIf(!HAS_JULIA)("prewarms Julia before singleton integration tests", async () => {
	if (!JULIA_PATH) return;
	await prewarmJulia(JULIA_PATH);
}, PREWARM_TIMEOUT_MS + 10_000);
