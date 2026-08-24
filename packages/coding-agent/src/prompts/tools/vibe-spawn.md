Starts persistent worker session. Prefer role when managed routing is available; otherwise cli is the vanilla fallback.

Managed roles (preferred when orchestrator available): `scout` | `utility` | `implementer` | `designer` | `planner` | `reviewer` — pass `role` and let the orchestrator supply model + routing (pool constraints, independence). When unavailable, roles use native routing defaults or report that the optional policy integration is unavailable.

Fallback: `cli` — `fast` (mechanical, low-latency) or `good` (hard, strong) — still fully supported for vanilla use.

`prompt`: first instruction — worker starts blank; include files, constraints, acceptance criteria.
`name`: optional label (48 chars).

Provide either `cli` or `role` (not both). Unknown role fails with list. Optional `model` pin bypasses routing (PIN_UNAVAILABLE if not in registry); `intent`/`routing`/`metadata` are generic routing/task linkage.

Returns id immediately; turn result self-delivers. Session persists; use `vibe_send` for follow-ups, never respawn same workstream.
