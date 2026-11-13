# Git worktrees

Run a kimchi session — or a subagent — inside a disposable git worktree under
`<main checkout>/.kimchi/worktrees/<name>`, so experiments never touch the
main checkout and several agents can work on the same repo at once.

## Quick start

```bash
kimchi --worktree fix-auth      # named worktree: .kimchi/worktrees/fix-auth, branch worktree-fix-auth
kimchi --worktree               # anonymous worktree: auto-named adjective-noun-hex
kimchi worktree list            # name, status (clean|dirty|commits), branch, path
kimchi worktree list --json     # machine-readable
kimchi worktree remove fix-auth # refuses when it holds work; pass --force to discard
kimchi worktree prune           # remove every clean, commitless kimchi worktree
```

## Layout and naming

- Worktrees live in `<mainRoot>/.kimchi/worktrees/<name>`; the directory
  contains a self-ignoring `.gitignore` (`*`) so `git status` in the main
  checkout never shows them.
- The branch is always `worktree-<name>`, created from the *fresh* base ref:
  `origin/HEAD` when reachable, otherwise local `HEAD`.
- Names: `[a-z0-9][a-z0-9-]*` (validated; `validateWorktreeName`). Anonymous
  sessions get `adjective-noun-hex4` (e.g. `bold-oak-a3f2`).
- Launching with `--worktree` from inside a worktree is refused (no nesting).
- Re-running `kimchi --worktree <name>` reuses an existing worktree. If it is
  clean, still on `worktree-<name>`, and has no commits of its own, the branch
  resets to the fresh base; otherwise it is left exactly as-is.

## `.worktreeinclude`

Project config is **not** copied automatically — a fresh worktree starts
unconfigured except for trust seeding (below). Add a `.worktreeinclude` file
in the main checkout (one path per line, `#` comments) to copy files into
every new worktree, e.g.:

```
.kimchi/config.json
.kimchi/permissions.local.json
```

Paths may be explicit files or directories. Kimchi runs
`git ls-files --cached --others -z` style matching so explicitly included
paths are carried even when gitignored (`.kimchi/` is typically ignored).

## Session lifecycle

- **Trust seeding** — when the main checkout resolves trusted, the worktree
  path inherits that trust (no double prompt). Never applied under
  `--no-approve`.
- **Session binding** — every worktree session appends a `kimchi_worktree`
  entry (dir, mainRoot, branch, name, named). Sessions started in worktrees
  appear in the resume picker (tagged `[worktree <name>]`) and in ACP
  `session/list` from the main checkout.
- **WorktreeCreate / WorktreeRemove hooks** — command-hook adapter events
  fired on create and successful removal, from all surfaces (CLI flag, agent
  isolation, subcommands). Payload on stdin:
  `{ hook_event_name, cwd, worktree: { name, dir, branch, main_root, kind } }`.
  Hooks are advisory (output ignored, failures swallowed). Project-scoped
  hooks only run when the project is trusted.
- **Exit rules (TUI)** —
  - anonymous + clean → removed silently;
  - named or has work → prompted (remove of a worktree *with* work requires a
    second confirmation);
  - headless (`-p`), ACP, or non-TTY → kept. Set
    `KIMCHI_WORKTREE_NO_PROMPT=1` to skip the prompt in tests.
- Resume a kept worktree session with `kimchi --worktree <name> --resume`.

## Subagent isolation

The `Agent` tool accepts `isolation: "worktree"`. Local runs then execute in a
disposable worktree named `agent-<id>-<type>` under `.kimchi/worktrees/`
(remote runs ignore it — the sandbox is already isolated):

- clean run (nothing uncommitted, untracked, or unpushed) → worktree and
  branch removed automatically;
- run that leaves work → kept, and the result ends with
  `Worktree: <dir> (branch <name>)` so the parent can diff/merge/cherry-pick;
- errored runs are kept too, for inspection.

`kimchi worktree prune` sweeps any leftovers.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `KIMCHI_WORKTREE` | Absolute path of the session's worktree (set by the pre-main hook) |
| `KIMCHI_WORKTREE_MAIN` | Main checkout root |
| `KIMCHI_WORKTREE_NO_PROMPT` | `1` disables the interactive exit prompt (e2e) |

## Telemetry

`worktree.created | kept | removed` events (source: user|agent, named,
had_work) — no paths or names, per the privacy policy.

## Notes

- Removal APIs refuse paths outside `<mainRoot>/.kimchi/worktrees/` — user
  worktrees created elsewhere are never touched.
- The harness edits this repo itself in a worktree
  (`kimchi-worktree`), which is how dogfooding surfaced the macOS
  `/var` symlink realpath normalization baked into all path handling.
