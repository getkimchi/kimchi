# Work in a separate checkout

From your repository, start Kimchi on its own branch and worktree:

```sh
kimchi --worktree fix/login
# Short form, with an initial task:
kimchi -w fix/login "Fix the login redirect"
```

Kimchi creates the branch from your current commit and opens a fresh session in `<primary-checkout>.worktrees/fix/login`. Your original checkout, branch, uncommitted edits and running sessions stay where they are. You can run several Kimchi sessions on different worktrees at the same time.

If the local branch already exists, Kimchi uses that branch's commit. If it is already checked out in another worktree, Kimchi reopens that checkout and preserves its edits. Choose a branch that nobody else is currently editing. Worktrees share Git history and refs; they are not security sandboxes.

New worktrees contain committed files. Install dependencies there as needed; Kimchi does not copy ignored files, credentials or uncommitted changes. Commit the changes you want as a starting point before creating a worktree.

## From a running session

Run `/worktree` to choose an existing checkout or create one. `/worktree fix/login` creates or reopens that branch directly. You can start a new session in the same terminal, resume the destination's latest session, or copy the displayed command into another terminal.

The same-terminal option pauses the original session. Exit the child with `/quit` to return to it. The child uses the selected model and its own project context; the conversation is not copied. `/worktree list` shows all registered checkouts.

## Resume and branch-only use

```sh
# Resume the most recent session in the destination worktree:
kimchi -w fix/login --continue

# Switch or create a branch in this checkout, without making a worktree:
kimchi --branch fix/login
```

`--branch` keeps uncommitted changes when Git can switch safely. It changes the branch in the current checkout, so use `--worktree` when other work is happening there. `/branch` still branches conversation history; it does not create a Git branch.

Worktree/branch launch flags support terminal and print sessions. They cannot be combined with `--resume`, `--session`, `--fork` or `--session-dir`, which could select a session from another directory. To resume a specific session, enter its worktree and run `kimchi --resume <id>`. ACP/RPC clients should set their session working directory directly. Explicit relative attachment and resource paths are resolved from the directory where you invoked the command.

## Keep or remove finished work

Kimchi keeps the worktree and branch when you exit. Review and commit your changes normally. Once every session using it has exited, run these from another checkout:

```sh
git worktree list
git worktree remove /path/to/repo.worktrees/fix/login
git branch -d fix/login
```

Git refuses normal removal of a dirty worktree, and `branch -d` refuses to delete an unmerged branch. Kimchi never forces either operation.
