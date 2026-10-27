# TUI wheel-scroll speed

In fullscreen mode, Kimchi uses pi-tui's velocity-based wheel scrolling (the `WheelScrollAccelerator`): slow wheel ticks scroll 1 line, fast spinning accelerates up to a cap. The default mode is `"auto"` (velocity-adaptive). To pin a fixed step instead (e.g., in iTerm2), configure:

```bash
kimchi config set tui.wheelScrollLines 3   # shows effective value: kimchi config get tui.wheelScrollLines
```

or edit the config file directly:

```jsonc
// ~/.config/kimchi/config.json — or <project>/.kimchi/config.json (trusted projects win)
{ "tui": { "wheelScrollLines": 3 } }
```

The value is synced into pi's `fullscreenWheelScrollLines` setting at startup (config always wins when set; pi's own `/settings` wheel-scroll option and the legacy `KIMCHI_WHEEL_SCROLL_LINES` env var are no longer consulted — leave `tui.wheelScrollLines` unset to keep pi's `"auto"` behavior or a setting chosen in `/settings`). Precedence: project config > global config > pi settings > `"auto"`. Valid values are integers ≥ 1. Changes apply after a restart — the value is read once when the TUI starts.
