# One-time switch to fullscreen TUI

Kimchi includes a hidden, enabled-by-default migration that switches a regular-TUI user to fullscreen **once**. This is a one-time onboarding migration, not a scheduled or timer-based action, and there is no public config setting or command to enable it.

## When the switch runs

All of these conditions must hold in one launch:

1. The session is an interactive chat TUI. ACP, print, protocol, non-TTY, help, version, export, and model-listing sessions return before changing settings or claiming completion.
2. The saved startup mode is `regular`. Sessions already starting fullscreen are left alone, and an explicit `--tui-mode regular` or `--tui-mode fullscreen` is respected as an opt-out from automatic migration.
3. The existing update cache contains a fresh confirmation that the current harness version is the latest version. Missing, stale, outdated, newer-than-release, or disabled confirmation leaves startup unchanged. The migration never adds a startup network request; a later launch can use fresher cache evidence.
4. The internal one-time completion marker has not already been claimed.

On an eligible launch, Kimchi uses Pi's `SettingsManager` to persist `tuiMode: "fullscreen"` in the **global settings**. This is not a session-only CLI override. Any later deliberate mode choice is honored: in particular, choosing regular after the one-time switch never triggers another forced switch.

## Completion and failures

Before changing the global setting, Kimchi atomically creates this internal marker:

```text
~/.config/kimchi/harness/one-time-fullscreen.json
```

(or `one-time-fullscreen.json` under the configured agent directory). Exclusive creation ensures concurrent launches cannot both claim the migration. Once the marker exists, subsequent launches leave the user's mode preference alone and do not consult the version cache. This at-most-once guarantee also applies if startup is interrupted after the marker is claimed.

If saving the global setting fails, the claim is removed when possible and startup continues without crashing. Unexpected settings or argument errors are also non-fatal and leave startup behavior unchanged.

This behavior is intentionally TUI-only. ACP and other non-TUI surfaces have no fullscreen layout to migrate and are unchanged.
