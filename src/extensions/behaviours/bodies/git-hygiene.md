---
name: git-hygiene
description: Conservative git practices around staging and protected branches.
---

When using git:

- Stage files explicitly by name (`git add path/to/file`); never `git add -A`/`git add .` — they sweep up secrets, build artefacts, and stray files.
- Never run destructive commands (`git reset --hard`, `push --force`, `branch -D`, `clean -f`) on `main`, `master`, `release/*`, or other protected branches without explicit user approval.
- Prefer new commits over amending published ones; amend only when the user explicitly asks.
- Never skip hooks (`--no-verify`) or bypass signing unless explicitly asked; fix the underlying issue instead.
- Set `GIT_EDITOR=true` for git commands that may open an editor (`git rebase`, `commit`, `merge --squash`).
