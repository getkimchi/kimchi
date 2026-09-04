# Herdr

Kimchi runs inside [herdr](https://herdr.dev/) panes and reports its lifecycle state and session identity automatically — no kimchi-side configuration required.

When herdr is present, kimchi publishes:

- Its current **lifecycle state** (`idle` / `working` / `blocked`)
- Any **blocked prompt** awaiting input
- Its **session ID** and session file path so herdr can resume the session later

herdr listens on its injected control socket and surfaces this information in the pane UI and status bar.

---

## Running kimchi in herdr

Start herdr in your project directory and open a kimchi pane:

```bash
herdr              # launches herdr in the current directory
```

Inside herdr, open `kimchi` in a new pane. herdr automatically injects the following environment variables into the pane:

| Variable | Meaning |
|----------|---------|
| `HERDR_ENV=1` | Marks the pane as running under herdr |
| `HERDR_PANE_ID` | The pane identifier herdr uses to address the agent |
| `HERDR_SOCKET_PATH` | Path to the herdr control socket kimchi writes state to |
| `HERDR_BIN_PATH` | Path to the herdr binary, used by wrapper hints |

Kimchi detects `HERDR_ENV=1` at session start and enables reporting. **No manual configuration is needed on the kimchi side** — there are no flags, environment variables, or settings entries to add.

---

## Lifecycle state reporting

Kimchi publishes one of three states to herdr's control socket as it runs:

| State | When |
|-------|------|
| `idle` | Kimchi is waiting for the next user prompt (or between turns). |
| `working` | Kimchi is actively processing a turn — running tools, calling the model, etc. |
| `blocked` | A permission prompt or question is open and requires user input. |

The state transitions track the session prompt: `idle` while the editor is waiting, `working` from the first tool call or model token through the end of the turn, and `blocked` whenever a confirmation/question overlay is shown. If a prompt times out or is dismissed, kimchi falls back to `idle`.

### Blocked prompts

When kimchi enters the `blocked` state, the payload includes the prompt text (truncated) so herdr can display a notification or surface it in the pane footer.

### Session identity

Kimchi also publishes:

- **`session_id`** — the resumable session identifier (the same value accepted by `--session`).
- **`session_path`** — absolute path to the on-disk session file, for inspection and backup.

herdr stores these so it can reattach a pane to the same session after a reconnect or restart.

---

## Detection note

herdr auto-detects the agent running in a pane from process and version metadata. Because kimchi is built on [pi-mono](https://github.com/badlogic/pi-mono), herdr may initially classify a kimchi pane as a **Pi agent** rather than as kimchi.

This does not affect any reporting — state, blocked prompts, and session identity are all published regardless of how herdr labels the pane.

To make herdr display the pane as kimchi, you have two options:

1. **Wrapper hint** — set `HERDR_AGENT=kimchi` in the pane environment. herdr uses this value as the agent label:

   ```bash
   HERDR_AGENT=kimchi kimchi
   ```

2. **Wait for upstream detection** — a future herdr release will add native kimchi detection based on kimchi's own process metadata.

---

## Session restore

Kimchi persists sessions automatically on every turn. To resume a session from outside herdr:

```bash
kimchi --session <session-id>
```

The `<session-id>` is the same value kimchi publishes to herdr as `session_id`.

In herdr, the reported session reference lets herdr **store the resume id** for each pane, but the actual resume happens via the kimchi CLI — herdr does not replay session state itself. To restore a herdr-attached session, close the pane and re-launch kimchi with `--session <id>`, or wire your own restore command to the pane's stored session id.

---

## Troubleshooting

- **No state shown in herdr** — confirm `HERDR_ENV=1` is present in the pane (`echo $HERDR_ENV`). If it's missing, the pane isn't running under herdr's agent manager.
- **`HERDR_SOCKET_PATH` not writable** — kimchi will log a warning and continue without reporting. State reporting is best-effort and never blocks the session.
- **Pane labeled as Pi** — see [Detection note](#detection-note) above; reporting still works, only the display label is affected.
