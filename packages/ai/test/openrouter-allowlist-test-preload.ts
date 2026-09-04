import { bootstrapOpenRouterAllowlistTestPolicy } from "./openrouter-allowlist-test-helpers";

// Bun test preload: install a hermetic allowlist for mock/provider suites. Dedicated
// allowlist contract tests override OMP_OPENROUTER_ALLOWLIST_PATH per case.
bootstrapOpenRouterAllowlistTestPolicy();
