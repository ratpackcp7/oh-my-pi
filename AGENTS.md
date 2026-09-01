# Development Rules

## Default context

- This is a monorepo; unless a task says otherwise, "agent" means the `packages/coding-agent/` CLI implementation and that package is the default focus.
- For package layout, coding-agent architecture, local loops, and subsystem references, read `packages/coding-agent/DEVELOPMENT.md` on demand.
- Catalog values come from `@oh-my-pi/pi-catalog/<module>`; `@oh-my-pi/pi-ai` re-exports only model/effort types used by its own signatures.

## Project invariants

- Unless the user provides the exact text, do not comment on GitHub, create GitHub issues, or start public discussions.
- Reuse central helpers before adding new ones; duplicate VCS, rendering, stream, temp-file, cache, or path logic is a bug. Detailed conventions: `docs/development-conventions.md#central-utilities`.
- Prompts are static `.md` assets imported with `{ type: "text" }`; use Handlebars for dynamic content rather than building prompts in code.
- Never hand-edit `packages/catalog/src/models.json`; for catalog work read `packages/catalog/README.md` first.

## Read before relevant work

- TypeScript/Bun style, workers, logging, TUI rendering, tests, changelogs, or merge formatting → `docs/development-conventions.md`.
- Coding-agent internals or new worker kinds → `packages/coding-agent/DEVELOPMENT.md` plus `docs/development-conventions.md#worker-scripts`.
- Rust/native/build-profile work → `Cargo.toml`, `.cargo/config.toml`, `rust-toolchain.toml`, and the Rust section in `docs/development-conventions.md`.
- `python/robomp/**` work → also read `python/robomp/AGENTS.md`; keep robomp-only procedures there, not here.
- Contributor/PR policy → `CONTRIBUTING.md`.
- Release work → read the changelog/release sections in `docs/development-conventions.md` and inspect `scripts/release.ts` before acting.

## Verification

- Use repo-native gates: `bun check` for the TypeScript gate and `bun run test:rs` for Rust tests; choose focused tests that exercise the changed observable contract.
