# SPEC — OMP eval runtime recovery + identity v1

## Objective
Fix the two runtime defects exposed by the pre-Orchestrator Opus benchmark without adding a second router or an LLM control layer.

1. `parallel()` must preserve settled sibling outcomes when one child fails so the caller can recover completed work and retry only failed/unknown assignments.
2. `agent()` runtime metadata must report authoritative parent/child provider, model, resource-pool, and fallback identity from OMP runtime state rather than model self-report.

## KISS constraints
- Deterministic runtime code only. No LLM discovery/classification.
- Existing dynamic worker router remains authoritative for route selection/fallback.
- No new retry scheduler. Preserve outcomes; expose them; let the caller decide what to retry.
- No service restart, deploy, merge, tmux action, or production mutation.
- Keep the implementation provider/model agnostic.

## Recovery contract
For Python eval `parallel()`:
- Wait for all submitted siblings to settle, as today.
- Before raising for any failure, persist a compact in-kernel status snapshot containing successful indices/results and failed indices/error summaries.
- Expose the snapshot via `parallel.last()`.
- Failure text names completed and failed indices and explicitly says to retry only failed indices.
- Reading `parallel.last()` is idempotent.
- A fully successful wave also replaces the last snapshot.
- Do not embed successful child output in exception text.

V1 covers the reproduced Python eval path. It does not claim durable recovery when the host completed a child but the individual bridge reply itself was lost before the kernel received it; that index remains unknown/failed and may be retried.

## Runtime identity contract
`runEvalAgent()` returns runtime-owned metadata derived from runtime/session/resolver state:
- `runtime_parent_provider`
- `runtime_parent_model`
- `runtime_parent_usage_pool`
- `runtime_child_requested_model`
- `runtime_child_resolved_provider`
- `runtime_child_resolved_model`
- `runtime_fallback_used`

Rules:
- Parent model comes from the active ToolSession model string.
- Parent provider/pool come from routing resource-pool helpers.
- Requested child model comes from the caller request and is never treated as resolved identity.
- Resolved child model comes from `SingleResult.resolvedModel`.
- Fallback comes from `SingleResult.resolvedModelIsFallback`; never infer it from child text.
- Child provider is parsed from the resolved selector.
- Agent prose claiming a model/provider cannot override these fields.

## Failure tests / acceptance gates
RED then GREEN coverage must prove:
1. mixed parallel wave: completed siblings remain available after one sibling fails;
2. completed index is not lost and failed indices are explicitly identified;
3. repeated `parallel.last()` reads are unchanged;
4. a later successful wave replaces stale failure state;
5. requested and resolved child model may differ and runtime metadata reports resolved identity;
6. fallback true/false follows runtime result state, not caller input/text;
7. parent provider/model/resource-pool are sourced from ToolSession/routing helpers;
8. existing eval behavior remains compatible when optional identity values are unavailable.

Run focused tests plus the relevant coding-agent type/check/test gate in CI.

## Stop condition
Stop at a green PR. Do not merge or deploy without explicit approval.