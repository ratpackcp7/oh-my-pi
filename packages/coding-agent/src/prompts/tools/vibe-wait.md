Blocks until ONE watched session finishes its current turn, the timeout elapses, or you are interrupted — not until all finish. Re-issue to keep waiting.

Turn results normally deliver themselves; you NEVER need this to receive output. Use it only when you are completely blocked and cannot direct any other session.

- `sessions` — ids to watch. Omit to watch every session with a turn in flight.
- `timeout` — seconds to wait; omit or pass 0 to wait up to the 25-minute deadman ceiling (worker may be stuck framing); pass an explicit positive value for a shorter poll.

A finished turn's full result (activity trace + response) is returned here and will not be re-delivered separately.
