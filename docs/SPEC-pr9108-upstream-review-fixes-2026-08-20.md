# SPEC — PR #9108 Upstream Review Fixes

**Date:** 2026-08-20
**Status:** Repair branch only. No live install, upstream head update, merge, restart, or deploy authorized by this SPEC.

## Objective

Repair every concrete blocking/P1/P2 finding on upstream `can1357/oh-my-pi` PR #9108 and make the runtime-model-identity contribution reviewable without silently changing default routing behavior.

Preserve the useful selected-vs-actual model identity/HUD work. Do not call the work done until regression tests reproduce the reported failure modes and an independent reviewer from a different provider reviews the frozen repaired diff.

## Context

Upstream review found:

1. PR scope is a grab-bag (85 files / ~6.8k lines) relative to the stated runtime-identity purpose.
2. `task.routing.enabled`/parent-pool avoidance create a default routing behavior change despite the PR body claiming none.
3. routing snapshot construction can call provider usage endpoints in the subagent preflight hot path.
4. dynamic `await import(...)` violates repository top-level-import conventions.
5. ledger append failures are swallowed by empty `catch {}`.
6. `*.ledger.jsonl` collides with transcript discovery and can create a fake persisted subagent.
7. selected model is captured after auth fallback, losing the originally requested route.
8. sibling-pool history mutates before batch preflight has fully succeeded.
9. OMP version identity must come from the canonical version source rather than stale literal/package probing.

## Read First

Before further editing, read:

1. upstream PR #9108 review threads;
2. repository `AGENTS.md` and any nested applicable `AGENTS.md`;
3. `packages/coding-agent/src/task/executor.ts`;
4. `packages/coding-agent/src/task/subagent-ledger.ts`;
5. `packages/coding-agent/src/task/routing/snapshot.ts`;
6. `packages/coding-agent/src/task/index.ts`;
7. `packages/coding-agent/src/task/structured-subagent.ts`;
8. `packages/coding-agent/src/config/settings-schema.ts`;
9. transcript discovery paths `registerPersistedSubagentsFromDir()` and `sessionFilesFromDisk()`;
10. runtime-model-identity and task-routing tests.

## Model / Capability Preflight

Before implementation/review, report:

- harness/runtime;
- provider;
- actual served model from machine-owned runtime evidence;
- repository path/branch/head SHA;
- Bun/Node versions;
- test capability;
- subagent/reviewer capability.

The implementation owner must not certify the final repaired diff. Final reviewer must be a different verified provider and must review the frozen diff after all fixes.

## Non-Goals

Do not:

- merge upstream PR #9108;
- mark it ready for review before gates pass;
- update the upstream PR head until the repair branch is green and independently reviewed;
- restart/redeploy/install live OMP, Hermes, Bridge, Docker, tmux, or services;
- add a new routing architecture;
- hide reviewer findings by changing prose only;
- preserve default-on routing merely to avoid changing tests;
- add network usage probes to task dispatch/preflight.

## Acerserver Safety Rules

No production-impacting actions are authorized. No restart, reset, tmux kill, service/Docker restart, process kill, redeploy, live install, or merge.

## Implementation Requirements

### A. Scope and default behavior

- Routing must not silently become default behavior for upstream users.
- Preferred repair: upstream runtime-identity PR should be identity-focused; routing should be opt-in (`task.routing.enabled` default false) or split into a separately reviewable contribution.
- Update PR claims only after actual code behavior matches them.

### B. Routing hot path

- `buildRoutingSnapshot()` must not call an API that can fetch provider quota/usage endpoints.
- Until a proven cache-only usage-health API exists, emit `usage: "unknown"` rather than performing network I/O during dispatch preflight.
- Add a regression test that fails if `fetch`/usage-fetch is invoked while building a routing snapshot.

### C. Ledger safety

- Use only top-level imports in source files.
- Store the sidecar under a suffix that cannot match transcript `*.jsonl` scanning (for example `.ledger.ndjson`).
- Use canonical OMP `VERSION` from `@oh-my-pi/pi-utils`.
- Ledger append remains best-effort but failures must emit a debug diagnostic; no empty `catch {}`.
- Add a regression test proving reopening/discovery does not register a ledger sidecar as a subagent transcript.

### D. Selected vs actual identity

- Capture the requested/routed selector before `resolveModelOverrideWithAuthFallback()` can replace it with the parent model.
- `selectedModel` must represent what was requested/chosen; `resolvedModel`/actual must represent what really served.
- Add an auth-fallback regression test where selected != actual.

### E. Batch sibling-pool mutation

- Do not mutate persistent `#siblingPoolKeys` during partial batch preflight.
- Accumulate batch-local pool keys and commit them only after all items pass preflight and the batch is dispatchable.
- Add a failure test: item 1 resolves, item 2 fails preflight, next independent call must see no phantom sibling history.

### F. Repo conventions

- No dynamic/inline imports in touched source.
- No empty catch for ledger writes.
- Run applicable format/lint/type/test checks.

## Failure Tests

Must reproduce and then prove fixed:

1. cold usage health cannot trigger provider network I/O from routing snapshot;
2. ledger sidecar cannot match transcript scanner;
3. auth fallback preserves requested selected model separately from actual model;
4. failed later batch preflight leaves sibling pool history unchanged;
5. routing is not enabled for a fresh default settings instance;
6. ledger failure produces diagnosable debug logging without failing child progress;
7. no dynamic imports remain in the touched source paths;
8. existing HUD/runtime identity tests remain green.

## Pass / Fail Acceptance Gates

PASS only if all are true:

- every upstream blocking/P1/P2 finding has a code fix and regression test;
- fresh/default settings do not silently enable dynamic worker routing;
- dispatch snapshot has zero provider-network usage probes;
- ledger sidecar is outside transcript `*.jsonl` namespace;
- selected identity survives auth fallback;
- failed batch preflight cannot poison sibling history;
- canonical OMP version source is used;
- repo import/logging conventions pass;
- relevant existing suites pass;
- repaired diff is frozen and independently reviewed by a different verified provider;
- independent review has no P0/P1/P2 findings;
- no live install/restart/deploy/merge occurred.

## Reporting Format

Report exactly:

1. `MODEL_PREFLIGHT`
2. `UPSTREAM_FINDINGS` mapping each review thread -> fix/test
3. `FILES_CHANGED`
4. `FAILURE_TESTS` with exact output
5. `REGRESSION_TESTS` with exact output
6. `DIFF_SCOPE`
7. `INDEPENDENT_REVIEW` provider/model/runtime evidence + verdict
8. `ACCEPTANCE_GATES` PASS/FAIL table
9. `REMAINING_RISKS`
10. `FINAL_RESULT: PASS | FAIL | STOP`

## Stop Conditions

Stop and report if:

- a fix requires a production-impacting action;
- the repaired diff cannot be tested without live provider/network calls;
- reviewer identity cannot be machine-attested;
- the repair would require hiding or dismissing an unresolved P0/P1/P2 finding;
- upstream/main has moved materially enough that the affected code paths must be re-audited before applying fixes.
