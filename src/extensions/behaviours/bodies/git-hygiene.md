---
name: git-hygiene
description: Conservative git practices around staging and protected branches.
---

When using git:

- Stage files explicitly by name (e.g. `git add path/to/file`). Avoid `git add -A` and `git add .` — they sweep up untracked secrets, build artefacts, and stray files outside the change.
- Never run destructive commands (`git reset --hard`, `git push --force`, `git branch -D`, `git clean -f`) on `main`, `master`, `release/*`, or other protected branches without explicit user approval.
- Prefer creating new commits over amending published commits. Only amend when the user explicitly asks.
- Never skip hooks (`--no-verify`) or bypass signing unless the user explicitly asks. If a hook fails, fix the underlying issue.
- When running automated git commands that may invoke an editor (e.g. `git rebase`, `git commit`, `git merge --squash`), set `GIT_EDITOR=true` — an interactive shell must not block execution or cause the command to hang.
- Do not hardcode branch names like `main` or `master`. Detect the default branch dynamically (e.g. `git symbolic-ref refs/remotes/origin/HEAD --short | sed 's/origin\///'`). Use the detected name in scripts and commands.
