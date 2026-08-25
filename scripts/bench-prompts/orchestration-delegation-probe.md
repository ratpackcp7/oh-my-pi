Answer one question about the repository at your current working directory.

Question: which module owns writing session transcripts to disk, and what is the exact on-disk filename pattern for a session JSONL file?

Rules for how you must work:

- Delegate the code search to exactly one `scout` subagent. Do not search the codebase yourself.
- Once the scout reports, answer from its findings. Do not re-read or re-grep files the scout already covered unless you can name a specific factual gap that its report left open.
- Do not edit, create, or delete any file.

Answer in at most five lines: the owning module path, the exported symbol that builds the filename, and the filename pattern.
