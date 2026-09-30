---
name: re-read-before-edit
description: Re-read a file before editing if a bash command ran since the last read.
---

Before every Edit/Write:

- If any bash command has run since you last read that file, re-read it first — formatters, linters, generators, pre/post hooks, and git operations may have changed it.
- Applies to every bash execution: explicit user commands, tool-triggered scripts, hooks, build steps. If in doubt, re-read.
- Never edit from a stale snapshot — a `read` call is cheap; a broken edit from outdated content wastes a turn and risks silent data loss.
