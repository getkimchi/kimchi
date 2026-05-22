# Teleport Mode

Teleport mode lets you spawn cloud sandboxes that mirror your local workspace. The agent runs remotely with full tool access while you stay in your local terminal. You can detach from a running session, reattach later, manage multiple sessions, sync files back and forth, and open interactive SSH shells on the remote sandbox.

## Prerequisites

Before using teleport mode you need:

- **An API key** — run `kimchi setup` if you haven't already.
- **rsync** — must be on your `PATH`. Install with `brew install rsync` (macOS) or `apt install rsync` (Linux).

## Launching teleport mode

Start kimchi with the `--teleport` flag:

```
kimchi --teleport
```

This opens the normal interactive session but with teleport capabilities enabled. You start on your local machine (the "home base"). From here you can use any of the teleport slash commands to spawn, manage, and interact with remote sandboxes.

### Environment variables

| Variable | Description |
|---|---|
| `KIMCHI_REMOTE_ENDPOINT` | Override the remote API endpoint (advanced/internal use). |
| `KIMCHI_API_KEY` | Provide an API key without running `kimchi setup`. |

---

## Commands

### `/teleport`

Spawn a new remote worker with a copy of your current workspace.

```
/teleport [name] [flags]
```

**What it does (rsync mode — default):**

1. Checks pre-flight conditions (idle session, rsync available, API key present, clean working tree).
2. Prompts for a git token if a git remote is detected (see [Git credentials prompt](#git-credentials-prompt)).
3. Authenticates and provisions a cloud sandbox.
4. Rsyncs your workspace to the remote.
5. Exports and loads your current session history so the remote agent has full context.
6. Propagates your local git identity (`user.name`, `user.email`) and credentials to the sandbox.
7. Connects and switches the foreground to the remote session.

**What it does (git-clone mode — with `--git-repo`):**

1. Checks pre-flight conditions (idle session, API key present). Rsync, dirty tree, and workspace size checks are skipped.
2. Prompts for a git token based on the repository URL's host (see [Git credentials prompt](#git-credentials-prompt)).
3. Authenticates and provisions a cloud sandbox.
4. Propagates git identity and credentials to the sandbox (before the clone, so private repos work).
5. Shallow-clones the repository on the sandbox (`--depth 1`). If `--git-branch` is set, checks out that branch. Use `--no-shallow` for full history.
6. Connects and switches the foreground to the remote session.

Session history is not transferred in git-clone mode — the remote agent starts fresh.

A progress indicator shows each stage as it completes. Input is locked during the teleport to prevent interference.

**Arguments:**

| Argument | Description |
|---|---|
| `name` | Optional. Give the session a name for easy reattachment later (e.g. `/teleport my-feature`). Names must be unique across your active sessions. |

**Flags:**

| Flag | Description |
|---|---|
| `--allow-dirty` | Proceed even if the git working tree has uncommitted changes. Without this flag, teleport refuses if there are uncommitted changes. |
| `--abandon-pending` | Force-abort a busy local session before teleporting. Without this flag, teleport refuses if the session is currently streaming or running a bash command. |
| `--force` | Proceed even if the workspace exceeds the 5 GB size limit. |
| `--skip-session` | Don't export or load the current session history on the remote. The remote agent starts fresh with no conversation context. |
| `--no-git-token` | Skip the git token prompt entirely. The remote sandbox won't be able to push/pull from private repositories. |
| `--git-repo <url>` | Clone from a git repository URL instead of rsyncing the local workspace. The sandbox will `git clone` the repository. Supports both HTTPS and SSH URLs. When this flag is set, rsync is not needed, and dirty-tree/workspace-size checks are skipped. |
| `--git-branch <branch>` | Branch to check out after cloning. Requires `--git-repo`. When specified, the clone uses `--single-branch` for faster cloning. If omitted, the repository's default branch is used. |
| `--no-shallow` | Clone the full git history instead of a shallow clone. Requires `--git-repo`. By default, git-clone mode uses `--depth 1` (only the latest commit) for speed. Use this flag if the agent needs access to git history (e.g. `git log`, `git blame`). |
| `--exclude <glob>` | Exclude files matching the glob from the rsync. Can be specified multiple times (e.g. `--exclude "*.log" --exclude "tmp/"`). Applied on top of the default excludes (`.git/`, `node_modules/`, etc.). Only applies in rsync mode (without `--git-repo`). |
| `--include-ignored` | Include files that are normally excluded by `.gitignore`. By default, gitignored files are not synced. Only applies in rsync mode (without `--git-repo`). |

**Examples:**

```
/teleport                              # spawn with defaults (rsync local workspace)
/teleport my-feature                   # spawn with a name
/teleport --allow-dirty                # ship uncommitted changes
/teleport backend --exclude "*.log"    # named session, skip log files
/teleport --skip-session --no-git-token  # minimal: no session history, no git credentials
/teleport --git-repo https://github.com/org/repo.git                    # clone a repo instead of rsyncing
/teleport --git-repo https://github.com/org/repo.git --git-branch main  # clone and check out a specific branch
/teleport my-task --git-repo git@github.com:org/repo.git --git-branch feature-x  # named session with git clone
```

After a successful teleport, a session indicator appears in the prompt (e.g. `(my-feature)` or `(remote)`) showing you're on a remote session.

---

### `/detach`

Disconnect from the foreground remote session. The remote sandbox keeps running on the server — you can reattach later.

```
/detach [flags]
```

After detaching you return to home base (your local session). The session indicator disappears.

**Flags:**

| Flag | Description |
|---|---|
| `--abandon-pending` | Force-abort a busy remote session before detaching. Without this flag, detach refuses if the remote is currently streaming or running a command. The remote has up to 10 seconds to become idle. |

After detaching, you'll see a hint like:

```
Detached from session abc12345. Reattach with /attach my-feature.
```

---

### `/attach`

Re-attach to a previously-detached remote session by name or ID.

```
/attach <name-or-id>
```

**Arguments:**

| Argument | Description |
|---|---|
| `name-or-id` | **Required.** The session name you gave at `/teleport` time, or the session UUID (a prefix is enough). |

**What it does:**

1. Looks up the session — first in locally-known detached sessions, then on the server.
2. Authenticates and reconnects.
3. Syncs git credentials if they haven't been propagated to this session yet.
4. Loads the remote session's message history.
5. Switches the foreground to the remote.

If the name doesn't match any session, kimchi suggests close matches (fuzzy matching).

**Examples:**

```
/attach my-feature          # by name
/attach abc12345            # by ID prefix
```

---

### `/connect`

Open an interactive SSH shell on the remote sandbox. This gives you direct terminal access to the sandbox environment — useful for debugging, inspecting files, or running commands manually.

```
/connect [target]
```

**Arguments:**

| Argument | Description |
|---|---|
| `target` | Optional. A session name or ID to connect to. If omitted, connects to the current foreground remote session. |

When you're done, exit the SSH session normally (`exit` or Ctrl-D) to return to kimchi.

If you're on home base (no foreground remote) and don't specify a target, `/connect` will tell you to provide a name/ID or use `/teleport` or `/attach` first.

**Examples:**

```
/connect                    # SSH into the current foreground remote
/connect my-feature         # SSH into a specific session by name
/connect abc12345           # SSH into a specific session by ID prefix
```

---

### `/sessions`

List all remote sessions and manage them through an interactive panel.

```
/sessions
```

This opens a full-screen TUI panel showing all your sessions grouped by state:

- **foreground** — the session currently wired to your terminal.
- **detached (this kimchi)** — sessions you detached from during this CLI run.
- **active elsewhere** — sessions that have another client connected.
- **detached** — sessions on the server with no connected client.

Each row shows the session ID, host, name, status, and last activity time.

**Panel keybindings:**

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Navigate the session list |
| `Enter` or `a` | Attach to the selected session |
| `s` | Open an SSH shell on the selected session (`/connect`) |
| `D` (Shift+D) | Delete the selected session (with confirmation) |
| `Esc` or `q` | Close the panel |

---

### `/sync`

Rsync files between your local workspace and the remote sandbox.

```
/sync <up|down> [path] [flags]
```

**Directions:**

| Direction | Description |
|---|---|
| `up` | Push local changes to the remote sandbox. |
| `down` | Pull remote changes to your local workspace. |

**Arguments:**

| Argument | Description |
|---|---|
| `path` | Optional. A relative path within the workspace to sync (file or directory). If omitted, syncs the entire workspace. Can also be provided via `--path <path>`. |

**Flags:**

| Flag | Description |
|---|---|
| `--exclude <glob>` | Exclude files matching the glob. Can be specified multiple times. Applied on top of default excludes. |
| `--include-ignored` | Include gitignored files in the sync. |
| `--delete` | Delete extraneous files at the destination that don't exist at the source. |
| `--no-delete` | Explicitly don't delete extraneous files (this is the default). |
| `--dry-run` | Show what would be transferred without actually doing it. |
| `--path <path>` | Alternative to the positional path argument. |

On completion, a summary shows the number of files and bytes transferred.

**Examples:**

```
/sync up                              # push entire workspace to remote
/sync down                            # pull entire workspace from remote
/sync up src/                         # push only the src/ directory
/sync down --path dist/               # pull only the dist/ directory
/sync up --dry-run                    # preview what would be pushed
/sync down --delete                   # pull and remove local files not on remote
/sync up --exclude "*.log" --exclude "tmp/"  # push, skipping logs and tmp
```

**Note:** You must be attached to a remote session to use `/sync`. If you're on home base, attach first with `/attach`.

---

## Git credentials prompt

When you run `/teleport` and kimchi detects a git remote (e.g. `github.com`), it shows an interactive prompt asking for a personal access token. This token is forwarded to the sandbox so the remote agent can push and pull from your private repositories.

**The prompt offers:**

- **Token input** — paste or type your token. The display is masked for security.
- **Save for future sessions** — toggle with `Tab`. When enabled, the token is saved locally so you won't be prompted again for the same host.
- **Skip** — press `Esc` to continue without git credentials. The remote won't be able to access private repos.

**Keybindings:**

| Key | Action |
|---|---|
| `Enter` | Submit the token |
| `Tab` | Toggle "Save for future sessions" |
| `Esc` | Skip (no git credentials) |

If you previously saved a token for the detected host, kimchi uses it automatically without prompting.

To skip the prompt entirely, use `/teleport --no-git-token`.

On subsequent `/attach` or `/connect` calls, kimchi automatically propagates saved credentials to the session if they haven't been synced yet — no re-prompting.

---

## Common workflows

### Clone a repo on a remote sandbox

```
/teleport --git-repo https://github.com/org/repo.git --git-branch feature-x
# ... agent works on the cloned repo ...
/sync down                     # pull changes back to local
/detach
```

This is useful when:
- You want the agent to work on a different repository than your current workspace.
- You don't have the repo cloned locally.
- You want a clean checkout without local modifications.

### Spawn, work, and return

```
/teleport my-task              # spawn a named remote session
# ... agent works on the remote ...
/sync down                     # pull changes back to local
/detach                        # disconnect (remote keeps running)
```

### Detach and reattach

```
/teleport my-task              # spawn
# ... work ...
/detach                        # go back to home base
# ... do something else locally ...
/attach my-task                # pick up where you left off
```

### Multiple sessions

You can run multiple remote sessions. Detach from one and teleport or attach to another:

```
/teleport frontend             # spawn first session
/detach                        # back to home base
/teleport backend              # spawn second session
/detach                        # back to home base
/sessions                      # see both sessions, pick one to attach
```

### Syncing specific files

```
/sync up src/config.ts         # push a single file
/sync down dist/               # pull an entire directory
/sync up --dry-run             # preview before pushing
```

### Inspecting the sandbox

```
/connect                       # SSH into the current remote
# run commands, inspect files, check processes
exit                           # return to kimchi
```

Or connect to a specific session while on home base:

```
/connect my-task               # SSH into a named session
```

---

## Limits and troubleshooting

### Workspace size

| Threshold | Behaviour |
|---|---|
| > 500 MB | Warning shown but teleport proceeds. Sync may take a while. |
| > 5 GB | Teleport refused. Use `--force` to override. |

**Tip:** Use `--exclude` to skip large directories you don't need on the remote (build artifacts, data files, etc.).

### Dirty working tree

By default, `/teleport` refuses if `git status --porcelain` shows uncommitted changes. This prevents accidentally shipping work-in-progress. Use `--allow-dirty` to override.

### Busy session

If the local session is streaming or running a bash command, `/teleport` refuses. Similarly, `/detach` refuses if the remote is busy. In both cases, use `--abandon-pending` to force-abort the in-progress work and proceed.

For `/teleport`, the local session has 5 seconds to become idle. For `/detach`, the remote has 10 seconds.

### rsync not found

If `rsync` is not on your `PATH`, teleport and sync commands will fail with an install hint. On macOS: `brew install rsync`. On Linux: use your package manager (e.g. `apt install rsync`).

### Session not found

If `/attach` or `/connect` can't find a session matching your input, kimchi will suggest close matches by name. You can also run `/sessions` to see all available sessions and pick one interactively.

### Completed sessions

Sessions that have finished and been cleaned up server-side cannot be reattached. You'll see: "Session has completed and is no longer reachable."
