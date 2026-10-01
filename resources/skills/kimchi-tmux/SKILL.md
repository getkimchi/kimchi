---
name: kimchi-tmux
description: Control Kimchi TUI through tmux.
---

# Kimchi tmux control

Use the bundled [controller script](scripts/harness-live.mjs) to start, inspect, drive, stop, and resume a real Kimchi session. It needs Node.js 22+, tmux, and an existing provider login. Invoke the script by its absolute path, resolved relative to this skill's location; skills may be loaded from a temporary copy.

The controller uses `kimchi` on PATH. To test a development checkout, build it with `pnpm run build:binary` and set `KIMCHI_BINARY=/absolute/checkout/dist/bin/kimchi` before `start`. The run saves that executable path for `resume`. No feature resource is required unless testing that feature.

```sh
node /absolute/skill/scripts/harness-live.mjs start <model> [provider]
node /absolute/skill/scripts/harness-live.mjs status <run-dir>
node /absolute/skill/scripts/harness-live.mjs type <run-dir> '/model'
node /absolute/skill/scripts/harness-live.mjs key <run-dir> Enter
node /absolute/skill/scripts/harness-live.mjs send <run-dir> '<prompt or /command>'
node /absolute/skill/scripts/harness-live.mjs send <run-dir> - < prompt.txt
node /absolute/skill/scripts/harness-live.mjs stop <run-dir>
node /absolute/skill/scripts/harness-live.mjs resume <run-dir>
```

Use the model the user requested; the provider defaults to `kimchi-dev`. Record the printed run directory. Each run gets a temporary Git workdir and starts in Plan mode, using existing settings/auth. Live model calls consume inference credits.

Inspect `status` until the editor is ready before injecting input, then between actions. `start` returning is not a readiness guarantee. Serialize controller calls for each run. `status` captures the original harness pane even if another pane/window becomes active, and prints the latest root session path. Its header describes the initial model; read the pane for the current model. Verify visible output and actual saved state rather than relying on an agent's claim.

`type` inserts one line without Enter and also fills menu search fields. `send` uses bracketed paste and Enter; use stdin (`-`) for multiline or large prompts. `/model` opens the model menu; `C-p` cycles models. Navigate with Up/Down, select with Enter, dismiss with Escape. Run `--help` for the supported keys, including Tab, Shift+Tab (`BTab`), Space, Backspace (`BSpace`), and PageUp/PageDown (`PPage`/`NPage`). `C-c` interrupts streaming but only denies the current request inside a permission dialog.

`stop` kills only the named tmux session and retains artifacts. `resume` chooses the latest root session, ignores evaluator children, and lets Kimchi restore its saved model. It requires a persisted session: an untouched editor may have nothing to resume. It does not restore an in-flight stream or open menu.

An agent driving the controller needs Default/Auto mode because Plan mode rejects launch; the child can remain in Plan mode. Approve scoped controller calls without disabling permission checks. A temporary workdir is not a security sandbox: keep prompts scoped there and forbid project/settings changes during read-only checks. For isolated checks, use a dedicated HOME and tmux server, keeping the same `TMUX_TMPDIR` for every call. Stop only sessions you created and remove temporary credentials after checking artifacts.
