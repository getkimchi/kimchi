# TUI wheel-scroll speed

In fullscreen mode (`tuiMode: "fullscreen"` in Kimchi's settings), one mouse-wheel notch scrolls **1 line** by default. To make wheel scrolling faster (e.g., in iTerm2), configure the step:

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

Precedence: env var > project config > global config > default `1`. Invalid values (non-numeric, zero, negative) are ignored and fall back to the default; fractional values (e.g. `2.7`) are accepted and floored. Alt+wheel multiplies the configured step by 5. Changes apply after a restart — the value is read once when the TUI starts.
