# One-time switch to fullscreen TUI

Kimchi includes a hidden, enabled-by-default migration that switches a regular-TUI user to fullscreen **once**. This is a one-time onboarding migration, not a scheduled or timer-based action, and there is no public config setting or command to enable it.

## When the switch runs

All of these conditions must hold in one launch:

1. The session is an interactive chat TUI. ACP, print, protocol, non-TTY, help, version, export, and model-listing sessions return before changing settings or claiming completion, as do Pi's one-shot subcommands (`auth`, `config`, `install`, `list`, `mcp`, `remove`/`uninstall`, `update`).
2. The migration respects the saved startup mode in the **global settings**. Project settings are not read, because the migration writes the global setting and a repository must not decide it. A project-level `tuiMode` still overrides the global one inside that project. Existing fullscreen users keep that setting and get the internal completion marker, so a later return to regular is also honored. An explicit `--tui-mode regular` or `--tui-mode fullscreen` is respected as an opt-out and does not claim the marker.
3. The internal one-time completion marker has not already been claimed.

For a regular-TUI user, Kimchi uses Pi's `SettingsManager` to persist `tuiMode: "fullscreen"` in the **global settings**. This is not a session-only CLI override. Already-fullscreen users are not rewritten. Any later deliberate mode choice is honored: in particular, choosing regular after the marker exists never triggers another forced switch.

## Completion and failures

Before changing the global setting, Kimchi atomically creates this internal marker:

```text
~/.config/kimchi/harness/one-time-fullscreen.json
```

(or `one-time-fullscreen.json` under the configured agent directory). Exclusive creation ensures concurrent launches cannot both claim the migration. Once the marker exists, subsequent launches leave the user's mode preference alone. This at-most-once guarantee also applies if startup is interrupted after the marker is claimed.

The marker records both a completed migration and a user who was already fullscreen and needs no migration. If saving the global setting fails, the claim is removed when possible and startup continues without crashing. Unexpected settings or argument errors are also non-fatal and leave startup behavior unchanged.

This behavior is intentionally TUI-only. ACP and other non-TUI surfaces have no fullscreen layout to migrate and are unchanged.
