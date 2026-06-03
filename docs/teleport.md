# Teleport

Teleport lets you spawn cloud sandboxes (workspaces) and run interactive PTY sessions inside them. You can open multiple sessions per workspace, sync files between your local machine and a sandbox, and switch between sessions with a tabbed terminal overlay.

## Enabling teleport

Teleport is available when the `KIMCHI_EXPERIMENTAL_TELEPORT` environment variable is set:

```bash
KIMCHI_EXPERIMENTAL_TELEPORT=1 kimchi
```

This exposes the teleport slash commands in your interactive session.

## Prerequisites

- **An API key** — run `kimchi login` if you haven't already.
- **rsync** — must be on your `PATH` for `/sync` and for `/teleport` when syncing a local workspace. Install with `brew install rsync` (macOS) or `apt install rsync` (Linux).

### Environment variables

| Variable | Description |
|---|---|
| `KIMCHI_REMOTE_ENDPOINT` | Override the remote API endpoint (advanced/internal use). |
| `KIMCHI_API_KEY` | Provide an API key without running `kimchi login`. |

---

## Core concepts

Teleport introduces three concepts that every flow builds on.

### Workspace

A **workspace** is a provisioned cloud sandbox. It has a unique ID, a host nickname, and a status. Workspaces persist until you explicitly delete them. You can run multiple sessions inside a single workspace.

You reference a workspace by:
- Its full UUID (e.g. `ws-abc123…`)
- Its host nickname (the left-most label of its hostname, e.g. `mybox`)
- Its name (if you gave it one during provisioning)

### Session

A **session** is a named PTY terminal session running inside a workspace. Each session has its own shell, working directory, and message history. Sessions are long-lived — they keep running on the server after you disconnect.

### Tab

When you open a session through the PTY overlay, it appears as a **tab** in the tab bar at the top of the screen. Tabs can be:

- **Eager** — actively connected via WebSocket (the session you `/teleport`-ed into).
- **Lazy** — present in the tab bar but disconnected. The WebSocket opens only when you switch to the tab. This keeps socket usage low.

---

## Commands

### `/teleport`

Spawn a new workspace (or reuse an existing one), create a PTY session, and open the tabbed overlay.

```
/teleport [name] [flags]
```

**What it does:**

1. Checks pre-flight conditions (clean working tree, rsync available, workspace size under limit — unless overridden).
2. Prompts for a git token if a git remote is detected (see [Git credentials prompt](#git-credentials-prompt)).
3. Authenticates and provisions a cloud workspace.
4. If you are in a git repo and did not pass `--git-repo`, rsyncs your local workspace to the remote.
5. Sets your local git identity (`user.name`, `user.email`) on the sandbox.
6. Propagates git credentials to the sandbox.
7. Creates a new PTY session in the workspace.
8. Exports and uploads your current session history so the remote agent has full context (unless `--skip-session`).
9. Opens the **tabbed PTY overlay** wired to the new session.

If a workspace already exists for the given `--workspace` ref, it is reused; a new session is created inside it. If you pass `--git-repo`, rsync is skipped and the repo is cloned on the sandbox instead.

**Arguments:**

| Argument | Description |
|---|---|
| `name` | Optional. Give the session a name. Allowed characters: letters, digits, `-`, `_`. Names must be unique within a workspace. If omitted, a random name is generated. |

**Flags:**

| Flag | Description |
|---|---|
| `--workspace <ref>` | Reuse an existing workspace instead of minting a new one. Accepts UUID, name, or host nickname. If omitted, a new workspace is minted automatically. |
| `--git-repo <url>` | Clone from a git repository URL instead of rsyncing the local workspace. Supports HTTPS and SSH URLs. |
| `--branch <branch>` | Branch to check out after cloning. Requires `--git-repo`. The clone uses `--single-branch` for speed. |
| `--allow-dirty` | Proceed even if the git working tree has uncommitted changes. |
| `--force` | Proceed even if the workspace exceeds the size limit. |
| `--no-git-token` | Skip the git token prompt entirely. The remote won't be able to access private repos. |
| `--skip-session` | Don't export or load the current session history on the remote. The remote agent starts fresh. |

**Examples:**

```
/teleport                              # spawn workspace + session with defaults
/teleport my-feature                   # spawn with a named session
/teleport --allow-dirty                # ship uncommitted changes
/teleport --git-repo https://github.com/org/repo.git --branch main
/teleport --workspace mybox task-2     # new session in existing workspace
```

After a successful teleport, the tabbed overlay opens and takes over the terminal.

---

### `/terminal`

Open a raw SSH shell into a workspace. This bypasses the PTY overlay and gives you a plain SSH session, useful for debugging or running one-off commands.

```
/terminal [workspace]
```

**Arguments:**

| Argument | Description |
|---|---|
| `workspace` | Optional. A workspace ref (UUID, name, or host nickname). If omitted and you have existing workspaces, an interactive picker is shown. If you have no workspaces, the command refuses. |

**What it does:**

1. Authenticates the workspace.
2. Propagates saved git credentials if available.
3. Hands off your TTY to an `ssh` process connected to the sandbox.

When you exit the SSH session (`exit` or Ctrl-D), you return to kimchi.

**Examples:**

```
/terminal mybox              # SSH into workspace mybox
/terminal ws-abc12345        # SSH by full workspace ID
```

---

### `/sync`

Rsync files or directories between your local machine and a remote sandbox workspace.

```
/sync up|down --workspace <ref> --source <path> --target <path> [flags]
```

**Directions:**

| Direction | `--source` | `--target` |
|---|---|---|
| `up` | local path | remote path |
| `down` | remote path | local path |

**Required flags:**

| Flag | Description |
|---|---|
| `--workspace <ref>` | The workspace to sync against. Accepts UUID, name, or host nickname. |
| `--source <path>` | What to copy. For `up`, a local path; for `down`, a remote path. |
| `--target <path>` | Where to copy it. For `up`, a remote path; for `down`, a local path. |

**Path conventions:**

- Absolute paths are used as-is.
- Relative local paths resolve against your current working directory.
- Relative remote paths resolve against the sandbox home (`/home/sandbox`). `~` on the remote expands to the same.
- For `down`, append a trailing `/` to `--source` if it's a directory. Without it, the source is treated as a single file.
- Rsync trailing-slash semantics apply: `--source foo/` copies the *contents* of foo into the target; `--source foo` copies the directory itself as a child of the target.

**Optional flags:**

| Flag | Description |
|---|---|
| `--exclude <glob>` | Skip files matching the glob. Repeatable. |
| `--include-ignored` | Include gitignored files in the transfer (default: skipped). |
| `--delete` | Delete extraneous files at the target that don't exist at the source. |
| `--no-delete` | Don't delete extraneous files (default). |
| `--dry-run` | Preview the transfer without writing anything. |

When `--source` is a directory, default excludes (`node_modules/`, `dist/`, `.next/`, `target/`, `__pycache__/`, `.venv/`, `.env*`, `*.log`, `.DS_Store`, `.kimchi/`, …) are applied, plus your repo's gitignored entries unless `--include-ignored` is set. When `--source` is a single file, only explicit `--exclude` patterns are applied.

On completion, a summary shows the number of files and bytes transferred.

**Examples:**

```
# Push a directory's contents to the sandbox
/sync up   --workspace mybox --source ./src/ --target /home/sandbox/project/src/

# Pull a directory back (note trailing slash on remote source)
/sync down --workspace mybox --source ~/project/dist/ --target ./dist/

# Push a single file
/sync up   --workspace mybox --source .env --target /home/sandbox/project/.env

# Dry run
/sync up   --workspace mybox --source ./ --target ~/project/ --dry-run --exclude "*.log"
```

---

### `/sessions`

List all sessions across all workspaces through an interactive TUI panel.

```
/sessions
```

This opens a full-screen panel showing every session grouped by workspace. Each row shows the workspace name, session name, status, and last activity time.

**Session status:**

| Status | Meaning |
|---|---|
| **active** | Session is alive and has a client connected. |
| **disconnected** | Session is alive but no client is connected. |
| **idle** | Session exists on the server but is not alive (e.g. process exited). |
| **completed** | Session has finished and been cleaned up. |
| **unreachable** | Could not reach the workspace to list its sessions. |

**Panel keybindings:**

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Navigate the list |
| `Enter` | Attach to the selected session (opens the PTY overlay) |
| `d` | Delete the selected session (with confirmation) |
| `Esc` or `q` or `x` | Close the panel |

---

### `/workspaces`

List and manage all workspaces through an interactive TUI panel.

```
/workspaces
```

This opens a full-screen panel showing every workspace with its host, status, session count, and last activity.

**Panel keybindings:**

| Key | Action |
|---|---|
| `↑` / `↓` or `j` / `k` | Navigate the list |
| `Enter` | Open a raw SSH terminal (`/terminal`) into the selected workspace |
| `d` | Delete the selected workspace and all its sessions (with confirmation) |
| `Esc` or `q` or `x` | Close the panel |

---

## The PTY overlay

When you `/teleport` into a workspace, you enter the **tabbed PTY overlay**. This is a fullscreen TUI that hosts one or more terminal sessions as tabs.

### Tab bar

A tab bar appears at the top of the screen. Each tab shows its index and session name:

```
 1:my-task │ 2:shell │⚠3:logs │ 4:server
```

**Tab indicators:**

| Indicator | Meaning |
|---|---|
| **Inverted background** | Active tab |
| `•` (dot) | Dirty — the tab received new output while it was inactive |
| `○` (circle) | Disconnected — lazy tab, WebSocket not yet opened |
| `⚠` (warning) | Degraded — reconnecting or fatal error |
| `…` (ellipsis) | Tab bar is truncated; more tabs exist off-screen |

### Tab navigation

Teleport uses a **Ctrl+B chord** system for switching tabs. Press `Ctrl+B`, release, then press the operand key:

| Chord | Action |
|---|---|
| `Ctrl+B` `n` | Next tab |
| `Ctrl+B` `p` | Previous tab |
| `Ctrl+B` `1`–`9` | Jump directly to tab 1–9 |
| `Ctrl+B` `Esc` | Cancel the chord |
| `Ctrl+D` | Exit the overlay entirely and return to local kimchi |

The chord state resets after one operand. Unknown operands are silently consumed so they don't leak into the active shell.

When you switch to a lazy tab, the WebSocket connects on demand and the session becomes active.

### Scrollback and selection

- **Scrollback** is handled natively by the terminal emulator. Mouse scroll events are forwarded to the remote session.
- **Mouse selection**: Click and drag to select text. Holding `Shift` or `Option` while selecting copies the selection directly to your **local clipboard** (bypassing the terminal's mouse protocol and any remote clipboard). This is the recommended way to copy from the remote sandbox to your local machine.
- **OSC 52 clipboard sync**: Remote programs that emit OSC 52 escape sequences (e.g. tmux with `set -g set-clipboard on`) automatically sync their clipboard to your local machine.

### Reconnection

If the WebSocket connection drops, the overlay shows a status banner and attempts automatic reconnection:

| Banner | Meaning | User action |
|---|---|---|
| `connecting…` | Initial connection in progress | Wait |
| `reconnecting in Ns (attempt M)…` | Transient disconnect, auto-retrying | Wait |
| `connection lost — ctrl+r retry · ctrl+d exit` | Recoverable fatal error | Press `Ctrl+R` to force a manual retry, or `Ctrl+D` to exit |
| `fatal: <reason> (<code>) — ctrl+d exit` | Non-recoverable fatal error (session terminated) | Press `Ctrl+D` to exit |

The overlay automatically refreshes the authentication token when it nears expiry, so long-running sessions stay connected.

### Closing tabs

When a session terminates normally (e.g. you type `exit` in the shell), its tab closes. If that was the last tab, the overlay exits and you return to local kimchi. A tab closed by a fatal error stays in the tab bar so you can see the banner and decide whether to retry or exit.

---

## Git credentials prompt

When you run `/teleport` and kimchi detects a git remote (e.g. `github.com`), it shows an interactive prompt asking for a personal access token. This token is forwarded to the sandbox so the remote agent can push and pull from private repositories.

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

If you previously saved a token for the detected host, kimchi uses it automatically. To skip the prompt entirely, use `/teleport --no-git-token`.

On subsequent `/terminal` calls or when reusing a workspace, kimchi automatically propagates saved credentials if they haven't been synced yet.

---

## Common workflows

### Spawn a workspace and work in the PTY overlay

```
/teleport my-task
# (tabbed overlay opens — work in the remote shell)
# Press Ctrl+D to exit; workspace and session keep running
```

### Re-enter a workspace later

```
/sessions                    # find your session, press Enter to attach
# or
/teleport --workspace mybox  # create a new session in the existing workspace
```

### Multiple sessions in one workspace

```
/teleport --workspace mybox task-1
# (in overlay)
# Ctrl+B n  to cycle to other sessions in the same workspace
# Ctrl+B 2  to jump directly to tab 2
```

Sessions share the same workspace filesystem but have independent shells and histories.

### Raw SSH for debugging

```
/terminal mybox
# run commands, inspect files outside the PTY overlay
exit                         # return to kimchi
```

### Clone a repo on a remote sandbox

```
/teleport --git-repo https://github.com/org/repo.git --git-branch feature-x
# (work in the cloned repo inside the overlay)
/sync down --workspace mybox --source ~/repo/ --target ./repo/
```

### Sync specific files

```
# Push a single file
/sync up --workspace mybox --source src/config.ts --target ~/project/src/config.ts

# Pull an entire directory
/sync down --workspace mybox --source ~/project/dist/ --target ./dist/

# Preview before pushing
/sync up --workspace mybox --source ./ --target ~/project/ --dry-run
```

### Manage sessions and workspaces

```
/sessions        # see all sessions across workspaces, attach or delete
/workspaces      # see all workspaces, open SSH terminal or delete
```

### Recover from a lost connection

```
# overlay shows: "connection lost — ctrl+r retry · ctrl+d exit"
Ctrl+R           # force reconnect with fresh token
# or
Ctrl+D           # exit overlay, then /sessions to reattach later
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

### rsync not found

If `rsync` is not on your `PATH`, `/sync` and `/teleport` (in rsync mode) will fail with an install hint. On macOS: `brew install rsync`. On Linux: use your package manager (e.g. `apt install rsync`).

### Session not found

If you reference a session that no longer exists, kimchi will suggest using `/sessions` to browse available sessions. Sessions that have finished and been cleaned up server-side cannot be reattached.

### Workspace not found

If you reference a workspace that doesn't exist (or that you don't have access to), authentication will fail. Use `/workspaces` to list your available workspaces.
