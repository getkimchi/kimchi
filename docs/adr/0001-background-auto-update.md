# Background auto-update instead of on-launch update

kimchi previously checked for, downloaded, installed, and re-exec'd into a
new version on every launch, before the TUI loaded. We replaced this with a
background update (see `GLOSSARY.md`): each interactive TUI session runs
update ticks in the background — the first ~10 seconds after session start,
then every 30 minutes — and installs in place atomically; the running
session keeps its version and the new one takes effect at the next launch.
The on-launch machinery (blocked startup, Ctrl+C-to-skip, `execve` hand-off)
is deleted because launch-time updating made every launch pay a network
check, stalled startup up to 30 seconds, and hijacked SIGINT semantics.

## Considered options

- **Keep on-launch updating.** Rejected: blocking UX, startup latency, and
  fragile re-exec were the problems being solved.
- **Claude Code's versions-directory layout** (`versions/<version>/` plus a
  swapped symlink) with per-process staging. Rejected: its main benefits
  are in-session switching and pruning of running versions — both needed
  for an in-session `/restart`, which is out of scope for kimchi. The
  existing atomic in-place install (`applyUpdate`) already works and stays.
- **Concurrent sessions coordinating via joined installs.** Rejected in
  favour of the simpler updater lock: one winner installs, others skip —
  the in-place install covers everyone.

## Consequences

- The install swaps the share directory (`vendor`/`bridge`, including
  bundled skills) while a running session may still read files from it.
  This is brief, already possible today across terminals, and accepted in
  exchange for keeping one atomic install and no launch-path work.
- A failed background update is invisible to the user: recorded in the
  update result, reported to telemetry, retried on the next tick.
- Manual `kimchi update` is unchanged and remains the way to update
  immediately, with one difference: it takes the updater lock like
  background ticks do and refuses with "already in progress" when a tick
  is mid-install (two installers would race on the share directory).
- The state file additionally records the last installed release tag:
  a session that installed stays on its old version at runtime, so
  without this record concurrent sessions would reinstall the same
  release on every one of their ticks.
- Homebrew installs refresh the bundled plugin bridge at TUI session
  start (a side effect previously attached to the deleted on-launch
  path); all other Homebrew update behaviour stays notify-only.
