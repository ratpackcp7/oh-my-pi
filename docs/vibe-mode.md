# Vibe mode

Vibe mode turns the top-level interactive session into a **director** for persistent background worker sessions instead of letting it edit or execute commands itself. The director's active tools are reduced to `read`, optional parent-owned `todo`, and five worker-control tools. Workers do the searching, editing, running, and building; the director verifies their claims by reading touched files. When available, `todo` belongs only to the parent director.

## Enabling and disabling

Toggle it with the `/vibe` slash command:

```text
/vibe                 # enter vibe mode
/vibe fix the flaky test in packages/tui   # enter and submit a first directive
/vibe                 # run again to exit
```

- Entering activates a parent-session worker scope, installs the vibe tools, reduces the active toolset to `read`, optional parent-owned `todo`, and the vibe tools, and injects the director instructions.
- An inline prompt (`/vibe <prompt>`) enters the mode and submits that prompt as the first directive.
- Exiting restores the prior toolset, cancels in-flight worker turns, kills every worker session in the scope, and persists terminal lifecycle records. A worker never outlives an intentional mode exit.
- Vibe mode is mutually exclusive with both active **and paused** plan/goal modes; exit those modes first.
- Starting, forking, moving, or handing off the session is rejected while vibe mode is active.
- The status line shows a `Vibe` indicator while the mode is on.

`/vibe` is an interactive-TUI command. The mode and worker lifecycle events are persisted with the parent session. Resuming a session whose current mode is `vibe` rehydrates completed workers as idle/parked sessions with their child transcripts; a turn interrupted by process restart is not resumed automatically. Explicitly killed or mode-exit workers stay terminal.

## The two worker tiers (vanilla fallback)

Every worker is a real, keep-alive task-executor subagent with the normal coding tool surface and its own persisted child transcript. For vanilla use (no orchestrator), choose a tier:

| Tier   | Bundled agent | Default role | Use for                                             |
| ------ | ------------- | ------------ | --------------------------------------------------- |
| `fast` | `sonic`       | `@smol`      | Mechanical execution, drafts, high-volume work      |
| `good` | `task`        | `@task`      | Design, judgment calls, and reviewing `fast` output |

The tier always selects the bundled `sonic` or `task` definition, not a same-named discovered custom agent. Model resolution otherwise matches task-agent routing: `task.agentModelOverrides.sonic` / `.task` wins over the bundled agent model, and role aliases resolve through `modelRoles`, with the parent active/default model as fallback. When managed policy is available, prefer role-oriented workers below — `fast`/`good` remain valid fallback, not the managed path.

## Generic role-oriented workers (preferred when managed)

For managed, policy-driven use (CP7 orchestrator / Foreman), `vibe_spawn` prefers a generic role-oriented shape. This is the same persistent Vibe worker; only the routing identity differs. `cli` (`fast`/`good`) remains fully backward compatible as the vanilla fallback. When the managed integration is absent, roles use native routing defaults or clearly report that the optional policy integration is unavailable.

| Role | Bundled agent | Typical intent | Use for |
|------|---------------|----------------|---------|
| `scout` | `scout` | `cheap` | Read-only reconnaissance |
| `implementer` | `task` | `strong` | Bounded implementation + tests |
| `designer` | `designer` | `strong` | UI/interface shaping |
| `planner` | `task` | `strong` | Decomposition |
| `reviewer` | `reviewer` | `strong` | Independent review when managed (never same family as implementer) |

New `vibe_spawn` fields (all optional, generic — no CP7 paths/imports in OMP core):

```ts
{
  cli?: "fast" | "good",                 // legacy tier, still valid
  role?: "scout" | "utility" | "implementer" | "designer" | "planner" | "reviewer",
  model?: string | string[],             // explicit pin, bypasses router; PIN_UNAVAILABLE if not in verified registry
  intent?: "default" | "cheap" | "normal" | "strong" | "vision" | "large-context" | "same-pool-ok",
  routing?: {
    excludePools?: string[],             // e.g. ["anthropic"] to avoid parent pool
    preferPools?: string[],
    allowParentPool?: boolean,           // false => fail-closed when only parent pool remains
    deadSelectors?: string[],            // exact selectors to exclude (reviewer independence via family expansion in adapter)
  },
  metadata?: {
    externalTaskId?: string,             // Foreman task id (generic, opaque to Vibe core)
    specPath?: string,
    policyHash?: string,
    policyRevision?: string,
    label?: string,
  },
  prompt: string,
  name?: string,
}
```

Rules:
- Provide either `cli` or `role` (not both, not neither); unknown `role` fails clearly with supported list.
- `role` selects the bundled agent via a tiny `VIBE_ROLE_AGENT` table; routing intent/pool handling reuses the native OMP task router (`task.routing.*` settings + `buildRoutingSnapshot` + `routeWorker`). No CP7 policy tables are copied into OMP.
- `model` is an explicit pin (like `agent(..., { model })`); if the pin is not in the verified `omp models --json` registry, spawn fails `PIN_UNAVAILABLE` with no silent substitution.
- Reviewer independence is enforced by the CP7 adapter (`rails/omp-orchestrator/vibe_adapter.py`) which expands the implementer's **actual served** model family (from `policy.json` families) into `deadSelectors` before spawning the reviewer. OMP core only sees generic `deadSelectors`.
- Foreman linkage is adapter-driven: Vibe stores `metadata` opaquely and surfaces it in `vibe_list` / TV wall (`task:<id>` badge), but never mutates Foreman state. Use `rails/foreman/vibe_foreman_bridge.py` to adopt results idempotently.

## Worker-control tools

| Tool         | Input and behavior                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibe_spawn` | `{ cli?: "fast" \| "good", role?: "scout"\|"utility"\|"implementer"\|"designer"\|"planner"\|"reviewer", model?: string\|string[], intent?, routing?, metadata?, prompt, name? }` — see above. `name` sanitized/capped at 48 chars; id generated when omitted. |
| `vibe_send`  | `{ session, message }`. Steers a streaming turn at its next step; if a turn exists but cannot be steered, queues an automatic next turn; if idle/parked, starts the next turn immediately.           |
| `vibe_wait`  | `{ sessions?, timeout? }`. Waits for the first watched turn to settle (all in-flight workers when omitted), default 30 seconds. It acknowledges settled jobs so their result is not delivered twice. |
| `vibe_kill`  | `{ session }`. Cancels an in-flight turn, clears queued messages, releases the worker, and retains any initialized transcript at `history://<id>`.                                                   |
| `vibe_list`  | `{}`. Lists sessions in spawn order with tier/role, state, turn/queue counts, planned vs actual model, intent, external task link, and recent activity.                                              |

Spawn and send return immediately. Each worker-turn result self-delivers into the director conversation through the async job manager; long response text is preview-capped there, with full output available at `agent://<id>`. Running `fast` and `good` workers on independent workstreams concurrently is the normal shape.

## Scope and failure behavior

Worker ids are scoped to the owning agent and parent session; a worker from another scope is reported as unknown and cannot be controlled. Spawning requires the session async job manager. Spawn failures tear down the partial record; turn failures self-deliver as failed job results, while a recoverable keep-alive worker returns to `idle` for another `vibe_send`. A worker whose registered child session can no longer be resolved becomes `dead`.

## Workflow

1. Split the request into independent workstreams — one persistent worker per workstream so each accumulates useful conversation context.
2. Call `vibe_spawn` with a self-contained brief: files, constraints, and observable acceptance criteria. Workers start blank and never see the director's conversation.
3. Keep directing other workers while turns are in flight. Use `vibe_wait` only when blocked; a timed-out wait can be reissued.
4. Use `vibe_send` naturally for corrections and next steps. A mid-turn send steers when possible; otherwise it becomes the worker's next turn automatically.
5. When a result arrives, `read` touched files and inspect full output when the preview is insufficient. Reconcile verified work through the optional parent `todo`.
6. Route by role when managed: `implementer` builds, `reviewer` verifies (independent family); otherwise route by difficulty: `fast` drafts, `good` judges.
7. Use `vibe_kill` for a finished/stuck worker. Exiting the mode kills the entire remaining scope.

The director remains responsible for the final outcome: worker completion means the turn settled, not that its claims are correct.
