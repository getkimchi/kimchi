---
name: re-read-before-edit
description: Re-read a file before editing if a bash command ran since the last read.
---

Before every Edit/Write:

- Check whether a bash command has executed since you last read that file. If it has, re-read the file first — formatters, linters, generators, and git operations may have changed it since your last read.
- This applies to any bash execution: explicit user commands, tool-triggered scripts, pre/post hooks, and build steps. If in doubt, re-read.
- Never edit from a stale snapshot. A single `read` call is cheap; a broken edit from outdated content wastes a turn and risks silent data loss.
