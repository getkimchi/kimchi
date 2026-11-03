# Kimchi

Language for the Kimchi harness. Currently covers one context: how kimchi
stays current.

## Auto-updating

**Background update**:
A version check and install performed while a session runs, never on the
launch path. The running session keeps its version; the installed version
takes effect at the next launch.
_Avoid_: on-launch update, silent update, hot reload

**Update tick**:
One run of the periodic background check — the first shortly after a session
starts, then on a fixed interval for as long as the session lives.
_Avoid_: poll, heartbeat

**Updater lock**:
The machine-wide exclusion that lets only one session install at a time.
A session that finds it held skips its tick.
_Avoid_: mutex, install lock

**Update result**:
The recorded outcome of the most recent check or install, kept for
diagnosis because a failed background update is never shown to the user.
_Avoid_: log, error state

**Update notice**:
The quiet status-line message about update state. Only an outcome
("✔ Update installed · Restart to update") is ever shown — never progress,
never failures.
_Avoid_: progress indicator, toast

**Auto-update notice**:
The one-time, persistent announcement that auto-update is on by default and
how to opt out. It must have been shown before any update may install.
_Avoid_: consent gate, opt-in banner
