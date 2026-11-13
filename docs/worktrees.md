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

## Switching worktrees mid-session (EnterWorktree / ExitWorktree)

In the interactive TUI the model can move the current conversation between
the main checkout and a worktree with two tools:

- `EnterWorktree { name? }` — creates (or reuses) the worktree, then restarts
  the session inside it, resuming the same session file;
- `ExitWorktree` — restarts the session in the main checkout. The worktree is
  kept (clean it up with `kimchi worktree remove`).

Mechanics: the tool writes a restart marker
(`<agentDir>/worktree-restart.json`), asks the model to stop, and requests a
graceful shutdown. After pi's main() returns, the CLI consumes the marker and
re-execs itself with `--worktree <name> --session <file>` (enter) or
`--session <file>` plus `KIMCHI_WORKTREE_LAUNCH_CWD=<mainRoot>` (exit, with
the worktree env binding dropped). On platforms without a re-exec primitive
(Windows) the equivalent `kimchi --worktree … --resume` command is printed
instead. The exit prompt is skipped for restart shutdowns.

ACP has no process to re-exec, so IDE clients use sessionless ext methods
instead and open sessions with the returned directory:

- `_kimchi.dev/worktree/create { cwd, name? }` → `{ name, dir, branch, mainRoot, baseRef }`
- `_kimchi.dev/worktree/list { cwd }` → `{ worktrees: [{ name, branch, path, status }] }`
- `_kimchi.dev/worktree/remove { cwd, name, force? }` → `{ removed: true }`

Upstream: a future pi `AgentSession.setCwd()` would allow switching without
shutting the session down; tracked in a pi-mono issue.

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
