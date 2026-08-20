#!/usr/bin/env python3
from pathlib import Path


def replace_exact(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}")
    p.write_text(text.replace(old, new, 1))


# applyCwdChange() resets capability caches after project relocation; the call
# existed on this feature branch without importing the registry reset helper.
replace_exact(
    "packages/coding-agent/src/modes/interactive-mode.ts",
    'import chalk from "@oh-my-pi/pi-utils/chalk";\nimport type { CollabGuestLink } from "../collab/guest";',
    'import chalk from "@oh-my-pi/pi-utils/chalk";\nimport { reset as resetCapabilities } from "../capability";\nimport type { CollabGuestLink } from "../collab/guest";',
)

# `overrides` already has a required id; declaring it once before the final
# spread creates TS2783 because the spread overwrites the first declaration.
replace_exact(
    "packages/coding-agent/test/runtime-model-identity.test.ts",
    '\t\tindex: 0,\n\t\tid: overrides.id,\n\t\tagent: "task",',
    '\t\tindex: 0,\n\t\tagent: "task",',
)
