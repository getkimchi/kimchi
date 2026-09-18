---
name: re-read-before-edit
description: Re-read a file before editing if a bash command ran since the last read.
---

Before every Edit/Write: if any bash command ran since you last read that file (formatters, hooks, generators, git ops), re-read it first — never edit a stale snapshot.
