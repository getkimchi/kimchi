---
name: bound-tool-output
description: Cap tool output at the source to preserve context.
---

Cap output before running a tool, not after — recovery from a flood is expensive:

- Bash: pipe to `head`/`tail` or pass `-n`/`--tail`. `git log -n 20 --oneline`, `git diff --stat`, `2>&1 | tail -100` for build/test/install output, `--log-failed` for CI logs, `| head -c 5000` or `| jq` for large `curl` responses, `tree -L 2`, never `git status -uall` on large repos.
- Content search: paths first (`files_with_matches` / `-l`), then content. Cap broad matches at ~50 hits, start with 2 lines of context, narrow scope with `--glob`/`--type` before searching.
- File reads: never read a known-large file (lockfiles, generated, fixtures) without an offset. Search to locate, then read around the hit.
- Don't `cat file | grep X` or `find . -name X` — use the harness's content/filename search tools instead.
