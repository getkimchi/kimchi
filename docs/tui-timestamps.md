# TUI transcript timestamps

Kimchi can show a datetime above activity in the interactive TUI transcript. This helps identify when a prompt, response, tool result, or other session event occurred, including after resuming an old session.

Timestamps are **disabled by default**. Enable them with:

```bash
kimchi config set tui.timestamps on
```

Disable them with:

```bash
kimchi config set tui.timestamps off
```

Use `kimchi config get tui.timestamps` to inspect the effective setting. External config changes apply after restarting the TUI.

Inside the running TUI, use the slash command instead; it persists the same settings and redraws the current transcript immediately without a restart:

```text
/timestamps                 # show current settings
/timestamps on
/timestamps off
/timestamps timezone local
/timestamps timezone UTC
/timestamps timezone Europe/Kyiv
```

The command is also listed in `/help` as `timestamps`.

## Timezones

The default timezone is `local`, which means the system timezone of the machine running Kimchi. Use UTC or an explicit [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) instead:

```bash
kimchi config set tui.timezone local
kimchi config set tui.timezone UTC
kimchi config set tui.timezone Europe/Kyiv
```

Use `kimchi config get tui.timezone` to inspect the effective setting, or `/timestamps` inside the TUI. Explicit timestamps include the numeric offset and use a locale-independent format:

```text
2026-11-23 15:04:05 GMT+2
```

Invalid values passed to `kimchi config set` or `/timestamps timezone` are rejected without writing. An invalid or missing timezone in a hand-edited config file falls back to local time.

The equivalent JSON configuration is:

```jsonc
// ~/.config/kimchi/config.json
{
  "tui": {
    "timestamps": true,
    "timezone": "Europe/Kyiv"
  }
}
```

A trusted project can also set these values in `<project>/.kimchi/config.json`. As with the existing `tui.wheelScrollLines` setting, the trusted project's complete `tui` object replaces the global one; include both project timestamp values if you want to override the defaults together.

## Covered activity

Each block has a small metadata row rather than a standalone log line: its role label appears in the accent color on the left, while the muted datetime is aligned to the right edge of the terminal. Narrow terminals truncate the row safely.

```text
user ·                                      2026-11-23 15:04:05 GMT+2
```

Datetime labels appear above these settled transcript blocks:

- User prompts and assistant responses
- Completed tool calls and bash executions
- Extension/custom messages and skill invocations
- Compaction and branch summaries

Tool labels show **completion time**. Live tool start times are transient, while final tool-result timestamps are persisted, so completion time works consistently during both live execution and session replay.

Transient spinners, notifications, dialogs, menus, and the input editor do not get labels. Timestamps are presentation-only: they are not added to model messages, tool inputs or results, session files, ACP/client output, print output, or exported HTML. ACP behavior is unchanged in the main turn, between turns, and during replay.

**ACP deferral:** `/timestamps` is intentionally not advertised in the ACP available-commands palette because it controls Kimchi's interactive TUI renderer only. ACP clients such as Studio and Zed own their own transcript presentation, so any future timestamp display there belongs in the client rather than in timestamps injected into agent message text.
