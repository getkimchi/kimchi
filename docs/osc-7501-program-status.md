# OSC 7501 program status

The interactive TUI emits OSC 7501 program-status sequences (`working` / `blocked` / `done` / `failed`), which terminals such as kitty and WezTerm use to display agent state in tabs or the window chrome.

## When it is emitted

- **Interactive TUI only.** Print mode (`-p`) and ACP/IDE mode never emit.
- **Detection-gated.** At TUI startup pi sends an `OSC 7501;?` query and enables emission only if the terminal answers before the primary Device Attributes reply. There are no `TERM` / `TERM_PROGRAM` / `CI` heuristics — no reply means nothing is emitted.
- **tmux:** tmux does not answer the query, so emission stays off unless forced.

## Overrides

- `PI_PROGRAM_STATUS=1` — force emission on.
- `PI_PROGRAM_STATUS=0` — force emission off.

Under tmux, forced emission must still pass through tmux to the outer terminal (`allow-passthrough`) to have a visible effect.

## Verification note

`tmux capture-pane -e` never shows OSC 7501 — tmux consumes unknown OSC sequences without storing them in the pane buffer. To check for `7501;state=` sequences under tmux, capture the raw output stream with `tmux pipe-pane` instead.
