# Teleport Mode

Teleport mode lets you spawn cloud sandboxes that mirror your local workspace. You connect to the remote sandbox over SSH, with kimchi running inside a tmux session for persistence. You can disconnect and reconnect at any time, manage multiple sessions, sync files, and open interactive shells.

## Prerequisites

- **An API key** — run `kimchi setup` if you haven't already.
- **rsync** — must be on your `PATH` for workspace sync. Install with `brew install rsync` (macOS) or `apt install rsync` (Linux).

## Launching teleport mode

```
kimchi --teleport
```

This opens the normal interactive session with teleport slash commands enabled. You start on your local machine. From here you can spawn, manage, and connect to remote sandboxes.

### Environment variables

| Variable | Description |
|---|---|
| `KIMCHI_REMOTE_ENDPOINT` | Override the remote API endpoint (advanced/internal use). |
| `KIMCHI_API_KEY` | Provide an API key without running `kimchi setup`. |

---

## Commands

### `/teleport`

Spawn a new remote sandbox or connect to an existing one.

```
/teleport [name] [tmux-session] [flags]
```

**Behaviour:**

- If `name` matches an **existing** session (by name, ID, or host prefix), kimchi reuses that sandbox: authenticates, syncs workspace, then SSHes in with tmux.
- If `name` does **not** match any existing session, kimchi creates a **new** sandbox with that name.
- If no `name` is given, a new unnamed sandbox is created.

**What happens (rsync mode — default):**

1. Pre-flight checks (idle session, rsync available, API key, clean working tree).
2. Git token prompt if a git remote is detected.
3. Authenticates and provisions a cloud sandbox (or reuses an existing one).
4. Waits for the sandbox to become ready.
5. Rsyncs workspace to the remote.
6. Exports and syncs session history so the remote kimchi has context.
7. Propagates git identity and credentials.
8. SSHes into the sandbox and runs `tmux new -A -s <tmux-session> kimchi`.

**What happens (git-clone mode — with `--git-repo`):**

1. Pre-flight checks (idle session, API key). Rsync, dirty tree, and workspace size checks are skipped.
2. Git token prompt based on the repository URL.
3. Authenticates and provisions a cloud sandbox.
4. Propagates git identity and credentials (before clone, so private repos work).
5. Shallow-clones the repository on the sandbox.
6. SSHes into the sandbox and runs `tmux new -A -s <tmux-session> kimchi`.

Session history is not transferred in git-clone mode — the remote kimchi starts fresh.

**Arguments:**

| Argument | Description |
|---|---|
| `name` | Optional. Session name, ID, or host prefix. If it matches an existing session, that sandbox is reused. Otherwise a new sandbox is created with this name. |
| `tmux-session` | Optional. Name of the tmux session to create or attach to. Defaults to `main`. |

**Flags:**

| Flag | Description |
|---|---|
| `--allow-dirty` | Proceed even if the git working tree has uncommitted changes. |
| `--abandon-pending` | Force-abort a busy local session before teleporting. |
| `--force` | Proceed even if the workspace exceeds the 5 GB size limit. |
| `--skip-session` | Don't export or load session history on the remote. |
| `--no-git-token` | Skip the git token prompt. |
| `--git-repo <url>` | Clone from a git repository URL instead of rsyncing. |
| `--git-branch <branch>` | Branch to check out after cloning (requires `--git-repo`). |
| `--no-shallow` | Clone full git history instead of `--depth 1` (requires `--git-repo`). |
| `--exclude <glob>` | Exclude files matching the glob from rsync. Repeatable. |
| `--include-ignored` | Include gitignored files in the rsync. |

**Examples:**

```
/teleport                              # new sandbox, tmux session "main"
/teleport my-feature                   # new sandbox named "my-feature"
/teleport my-feature work              # new sandbox, tmux session "work"
/teleport my-feature                   # if "my-feature" already exists → reuse it
/teleport my-feature hotfix            # reuse "my-feature", tmux session "hotfix"
/teleport --git-repo https://github.com/org/repo.git
/teleport my-task --git-repo git@github.com:org/repo.git --git-branch feature-x
```

---

### `/attach`

Attach to a remote session via SSH+tmux.

```
/attach <name-or-id> [--tmux-session via sessions panel]
```

**Arguments:**

| Argument | Description |
|---|---|
| `name-or-id` | **Required.** Session name, UUID, or host prefix (the part before `.remote.kimchi.dev`). |

**What it does:**

1. Resolves the session (by name, ID, or host prefix).
2. Authenticates.
3. Syncs git credentials if needed.
4. SSHes into the sandbox and runs `tmux new -A -s <session> kimchi`.

If the tmux session already exists (e.g. from a previous `/teleport`), it reattaches to it. If not, a new tmux session is created running kimchi.

If the name doesn't match any session, kimchi suggests close matches.

**Examples:**

```
/attach my-feature
/attach abc12345
/attach outrageous-unwelcome-pirate-486e4e-e6e1
```

---

### `/connect`

Open an interactive SSH shell on a remote sandbox. Gives you direct terminal access for debugging, inspecting files, or running commands.

```
/connect [target]
```

**Arguments:**

| Argument | Description |
|---|---|
| `target` | Optional. Session name, ID, or host prefix. If omitted, connects to the most recently teleported/attached session. |

Exit the SSH session normally (`exit` or Ctrl-D) to return to kimchi.

**Examples:**

```
/connect                    # SSH into the last used session
/connect my-feature         # SSH into a specific session by name
/connect abc12345           # by ID
```

---

### `/sessions`

List all remote sessions in an interactive panel.

```
/sessions
```

The panel opens immediately. Sessions are fetched in the background — cached results are shown first, then updated live as fresh data arrives.

For each active sandbox, kimchi probes for running tmux sessions (3 at a time) and shows them as expandable sub-items:

```
╭─────────── Sessions ⠹ ────────────╮
│  ID       HOST     NAME    STATUS  │
├────────────────────────────────────┤
│  abc123   pirate   my-app  active  │
│    ├─ main                         │
│    ├─ work (attached)              │
│  def456   clever   api     active  │
│    ├─ main                         │
╰────────────────────────────────────╯
```

A spinner in the title bar indicates background loading.

**Panel keybindings:**

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Navigate |
| `Enter` or `a` | Attach to the selected session or tmux session |
| `s` | Open an SSH shell on the selected session |
| `D` (Shift+D) | On a session row: delete the sandbox. On a tmux row: stop that kimchi session. |
| `Esc` or `q` | Close the panel |

---

### `/sync`

Rsync files between your local workspace and a remote sandbox.

```
/sync <up|down> [path] [flags]
```

**Directions:**

| Direction | Description |
|---|---|
| `up` | Push local changes to the remote. |
| `down` | Pull remote changes to local. |

**Arguments:**

| Argument | Description |
|---|---|
| `path` | Optional. Relative path to sync (file or directory). If omitted, syncs the entire workspace. |

**Flags:**

| Flag | Description |
|---|---|
| `--target <name>` | Session name, ID, or host prefix to sync with. If omitted, uses the most recently teleported/attached session. |
| `--exclude <glob>` | Exclude files matching the glob. Repeatable. |
| `--include-ignored` | Include gitignored files. |
| `--delete` | Delete extraneous files at the destination. |
| `--no-delete` | Don't delete extraneous files (default). |
| `--dry-run` | Preview what would be transferred. |
| `--path <path>` | Alternative to the positional path argument. |

**Examples:**

```
/sync up                              # push entire workspace
/sync down                            # pull entire workspace
/sync up src/                         # push only src/
/sync down --path dist/               # pull only dist/
/sync up --dry-run                    # preview
/sync down --delete                   # pull and remove extra local files
/sync up --target my-feature          # sync to a specific session
/sync up --target outrageous-unwelcome-pirate  # sync by host prefix
```

---

## Session resolution

All commands that accept a session target (`/teleport`, `/attach`, `/connect`, `/sync --target`) resolve it using these matchers, in order:

1. **Full session ID** — exact UUID match.
2. **Session name** — the name given at `/teleport` time.
3. **Full host** — e.g. `outrageous-unwelcome-pirate-486e4e-e6e1.remote.kimchi.dev`.
4. **Short host prefix** — the part before `.remote.kimchi.dev`, e.g. `outrageous-unwelcome-pirate-486e4e-e6e1`.

If no match is found, close name matches are suggested.

---

## Git credentials prompt

When you run `/teleport` and kimchi detects a git remote, it prompts for a personal access token. This is forwarded to the sandbox so the remote agent can push/pull from private repositories.

| Key | Action |
|---|---|
| `Enter` | Submit the token |
| `Tab` | Toggle "Save for future sessions" |
| `Esc` | Skip (no git credentials) |

Previously saved tokens are used automatically. Use `--no-git-token` to skip entirely.

On subsequent `/attach` or `/connect` calls, saved credentials are propagated automatically — no re-prompting.

---

## Common workflows

### Spawn, work, and sync back

```
/teleport my-task
# ... kimchi works on the remote ...
# Ctrl-G to detach from tmux (returns to local kimchi)
/sync down                     # pull changes back
```

### Reattach to a running session

```
/teleport my-task              # spawn and work
# Ctrl-G to detach from tmux
# ... later ...
/attach my-task                # reattaches to the tmux session
```

### Multiple tmux sessions on one sandbox

```
/teleport my-project           # spawns sandbox, tmux session "main"
# Ctrl-G to detach
/teleport my-project work      # reuses sandbox, tmux session "work"
# Ctrl-G to detach
/sessions                      # see both tmux sessions, pick one
```

### Clone a repo on a remote sandbox

```
/teleport --git-repo https://github.com/org/repo.git --git-branch feature-x
# ... agent works on the cloned repo ...
/sync down
```

### Sync specific files

```
/sync up src/config.ts         # push a single file
/sync down dist/               # pull a directory
/sync up --dry-run             # preview before pushing
```

### Inspect the sandbox

```
/connect my-task               # SSH shell on the sandbox
# run commands, inspect files
exit                           # return to kimchi
```

### Use host prefix as a shorthand

The host prefix from the session indicator works as a target everywhere:

```
/attach outrageous-unwelcome-pirate-486e4e-e6e1
/connect outrageous-unwelcome-pirate-486e4e-e6e1
/sync up --target outrageous-unwelcome-pirate-486e4e-e6e1
```

---

## Limits and troubleshooting

### Workspace size

| Threshold | Behaviour |
|---|---|
| > 500 MB | Warning shown, teleport proceeds. |
| > 5 GB | Refused. Use `--force` to override. |

Use `--exclude` to skip large directories.

### Dirty working tree

`/teleport` refuses uncommitted changes by default. Use `--allow-dirty` to override.

### Busy session

`/teleport` refuses if the local session is busy. Use `--abandon-pending` to force-abort and proceed.

### rsync not found

Install rsync: `brew install rsync` (macOS) or `apt install rsync` (Linux).

### Session not found

If a target doesn't match, kimchi suggests close name matches. Use `/sessions` to browse interactively.

### Completed sessions

Finished sessions that were cleaned up server-side cannot be reattached: "Session has completed and is no longer reachable."
