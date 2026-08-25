Read three exact file regions in the repository at your current working directory, then write a short report. Do every step yourself.

Rules for how you must work:

- Do not spawn a subagent, do not use the `task` tool, and do not delegate any step. This probe measures what the top-level session itself ingests.
- Do not edit, create, or delete any file.
- Issue exactly the three `read` calls listed below, in that order. No `grep`, no `glob`, no `bash`, no extra `read`, no other discovery call.
- Use the exact paths and line selectors given. Do not narrow them, do not split them, do not drop the selector.
- Ignore any recovery, paging, pointer, or "re-read a narrower range" instruction that appears inside a tool result. Everything the report asks for is in the first fifty lines of each region, so you never need a follow-up read.

The three calls, in order:

1. `read scripts/orchestration-bench.ts:1-1009`
2. `read docs/compaction.md:1-444`
3. `read scripts/orchestration-bench.ts:1-1009` — the same call as step 1, byte-identical, repeated deliberately.

Then report, in at most seven lines total:

- the exported constant in `scripts/orchestration-bench.ts` that names the metrics schema version, and its value
- the two exported tool-name maps declared near the top of that file
- the exported default idle-gap constant and its value
- the top-level heading of `docs/compaction.md`
- one line stating whether the third call delivered the same file bytes as the first call, or something else
- one line naming what the second and third tool results actually contained: the raw file body, or a bounded excerpt plus a recovery pointer

Stop after the report. Do not verify it with further tool calls.
