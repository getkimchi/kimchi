# TUI wheel-scroll speed

In fullscreen mode (`tuiMode: "fullscreen"` in Kimchi's settings), one mouse-wheel notch scrolls **1 line** by default. For terminals known to forward wheel events 1:1 (making scrolling feel slow), Kimchi auto-detects the terminal and raises the default to **3 lines** — no configuration needed:

| Terminal / platform | Default |
|---|---|
| Windows (any terminal, incl. WSL via `WT_SESSION`) | 3 |
| VS Code, Cursor, Windsurf, VSCodium (`TERM_PROGRAM=vscode`) | 3 |
| iTerm2 (`TERM_PROGRAM=iTerm.app`) | 3 |
| JetBrains IDEs — GoLand, IntelliJ, … (`TERMINAL_EMULATOR=JetBrains-*`) | 3 |
| WezTerm (`TERM_PROGRAM=WezTerm` / `WEZTERM_PANE`) | 3 |
| Kitty (`KITTY_WINDOW_ID` / `TERM=xterm-kitty`) | 3 |
| everything else | 1 |

Detection is env-var heuristics only (there is no escape sequence to negotiate wheel deltas). Inside tmux or over SSH the outer terminal's markers may be gone, in which case the default stays 1 — with two deliberate exceptions: `WEZTERM_PANE` and `WT_SESSION` survive into tmux/WSL sessions, and Kitty is also detected over SSH because ssh forwards `TERM` (the remote app receives Kitty's same 1:1 wheel events, so the bump follows intentionally). Terminals that already multiply wheel events client-side (e.g. Alacritty's `scrolling.multiplier`) are deliberately **not** bumped, to avoid double-applying.

Any explicitly configured value overrides the detected default:

```bash
kimchi config set tui.wheelScrollLines 3   # shows effective value: kimchi config get tui.wheelScrollLines
```

or edit the config file directly:

```jsonc
// ~/.config/kimchi/config.json — or <project>/.kimchi/config.json (trusted projects win)
{ "tui": { "wheelScrollLines": 3 } }
```

Alternatively set the environment variable, which takes precedence over config:

```bash
export KIMCHI_WHEEL_SCROLL_LINES=3
```

Precedence: env var > project config > global config > terminal-detected default (3) > `1`. Invalid values (non-numeric, zero, negative) are ignored and fall back to the default; fractional values (e.g. `2.7`) are accepted and floored. Alt+wheel multiplies the configured step by 5. Changes apply after a restart — the value is read once when the TUI starts.
