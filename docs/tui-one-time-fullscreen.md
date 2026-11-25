# One-time switch to fullscreen TUI

Kimchi includes a hidden, enabled-by-default migration that switches the regular TUI to fullscreen **once**. This is a one-time onboarding migration, not a scheduled or timer-based action, and there is no public config setting or command to enable it.

## When the switch runs

All of these conditions must hold in one launch:

1. The session is an interactive terminal TUI. ACP, print, protocol, and non-TTY sessions return before reading settings, checking versions, or writing state for this feature.
2. The effective startup mode after settings and `--tui-mode` resolution is `regular`. Sessions already starting in fullscreen are left alone.
3. The running harness is confirmed current through the existing update checker and its shared cache. Stable releases must match the latest release version. Canary builds must be on the latest build of the same commit.
4. The internal one-time completion marker has not already been claimed.

The switch adds a one-shot `--tui-mode fullscreen` startup override. It does **not** rewrite `settings.json` or the user's saved `tuiMode` preference. A later deliberate choice of regular or fullscreen mode therefore remains the user's choice; in particular, choosing regular after the one-time switch never triggers another forced switch.

## Completion and failures

On an eligible launch, Kimchi atomically creates this internal marker:

```text
~/.config/kimchi/harness/one-time-fullscreen.json
```

(or `one-time-fullscreen.json` under the configured agent directory) before Pi starts. Exclusive creation ensures that concurrent launches cannot both claim the automatic switch. Once this marker exists, subsequent launches do not run an update check or switch modes for this feature. This at-most-once guarantee also applies if startup is interrupted after the marker is claimed.

If the version is outdated, newer than the available release, cannot be checked, has update checks disabled, or otherwise cannot be confirmed as latest, startup stays in its requested mode and does not claim completion. A later eligible launch may try again. If the completion marker cannot be persisted, or another launch claims it first, the automatic switch is skipped.

This behavior is intentionally TUI-only. ACP and other non-TUI surfaces have no fullscreen layout to migrate and are unchanged.
