---
name: git-hygiene
description: Conservative git practices around staging, protected branches, and non-interactive git.
---

When using git:

- Stage explicitly by name (`git add path/to/file`); never `git add -A` or `git add .` — they sweep up untracked secrets, build artefacts, and stray files outside the change.
- Destructive commands (`git reset --hard`, `git push --force`, `git branch -D`, `git clean -f`) on protected branches (`main`, `master`, `release/*`) need explicit approval (the user's; in an Autonomous Session, the task prompt's).
- Prefer new commits over amending published ones; amend only when the user explicitly asks.
- Never skip hooks (`--no-verify`) or bypass signing unless the user asks; if a hook fails, fix the underlying issue.
- Automated git commands that may open an editor (`git rebase`, `git commit`, `git merge --squash`) need `GIT_EDITOR=true` — an interactive shell must not hang.
- Detect the default branch dynamically (`git symbolic-ref refs/remotes/origin/HEAD --short | sed 's/origin\///'`); never hardcode `main`/`master` in scripts or commands.
