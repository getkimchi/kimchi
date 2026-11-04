# Auto-update

How kimchi stays current: a background update model (check + install during
the session, applied at the next launch) that replaced the earlier blocking
on-launch update. See [Vocabulary](#vocabulary) for the terms used here and
in the code, and [Why background updates](#why-background-updates) for the
decision record.

## How it works

Each interactive TUI session runs **update ticks**: the first ~10 seconds
after session start, then every 30 minutes for as long as the session lives.
Nothing runs in ACP/JSON/RPC/print/export modes — ACP clients own harness
updates themselves.

One tick (`runUpdateTick`, `src/update/background.ts`):

1. **Take the updater lock.** If another session holds it, the tick returns
   `skipped-lock` — the winner's in-place install covers the whole machine.
2. **Check** GitHub releases via `checkForUpdate`, honoring the shared
   30-minute cache, so N open sessions still mean at most one check per
   machine per 30 minutes.
3. **Dedup** against the last-installed release tag written by any session:
   a session that installed stays on its old version at runtime (the install
   applies to the *next* launch), so without this record concurrent sessions
   would reinstall the same release every tick.
4. **Install** via `applyUpdate` — download → checksum → extract →
   smoke-test → atomic in-place rename. Binary *and* share dir
   (`vendor`/`bridge`) swap mid-session; Windows rotates `kimchi.exe.old`.
5. **Record** the outcome (the update result) and, after a successful
   install, the last-installed tag — both persisted while the lock is still
   held. Each finished tick also emits an `update:tick-finished` fact on the
   internal events bus (the OTLP translation lives in the telemetry stack).

A successful install stops the session's tick loop: this session has nothing
more to do — the next launch is the new version.

## Gates

Ticks never run on:

- Homebrew installs (brew owns the upgrade; the bundled plugin bridge is
  refreshed at TUI session start instead)
- canary builds (canary updates only via `kimchi update --canary`)
- dev/source launches and non-packaged binaries (an install would overwrite
  the interpreter)
- `KIMCHI_NO_UPDATE_CHECK` set
- `--no-auto-update` on the command line (per-session skip)
- the persisted `autoUpdates: false` setting (permanent off switch)
- before the one-time **auto-update notice** has been shown. The notice is a
  *dynamic* gate: startup-update marks it during the first session's
  `session_start`, so the tick re-reads it at run time rather than relying
  on extension registration order.

## UX

The only thing ever shown is one line on the status bar, after an install
completes mid-session:

```text
✔ Update installed · Restart to update
```

No progress while checking or downloading, no failure messages, no
release-note summary at the next launch. Opt-out users (auto-update off, or
Homebrew) keep the existing `Update available! Run kimchi update` /
`brew upgrade kimchi` nag.

## Failures

A failed tick is invisible by design. It is written to the **update result**
in `~/.cache/kimchi/state.json`, emitted as telemetry, and retried plainly
on the next 30-minute tick — no backoff, and a later success simply
replaces the failed state. The updater lock has a 15-minute staleness
escape so an install interrupted by kill -9 (or a recycled PID) cannot
strand the lock forever.

## Manual update

`kimchi update` (and `/update` → "Update kimchi now") works as before and
remains the way to update immediately, with one difference: it takes the
updater lock like ticks do and refuses while an install is in progress —
two concurrent installers would race on the share-directory swap.

## Why background updates

The previous design checked for, downloaded, installed, and re-exec'd into
a new version on every launch, before the TUI loaded. Launch-time updating
made every launch pay a network check, could stall startup up to 30
seconds, hijacked SIGINT semantics (Ctrl+C-to-skip), and needed a fragile
re-exec fallback chain.

Considered options:

- **Keep on-launch updating.** Rejected: blocking UX, startup latency, and
  fragile re-exec were the problems being solved.
- **Claude Code's versions-directory layout** (`versions/<version>/` plus a
  swapped symlink) with per-process staging. Rejected: its main benefits
  are in-session switching and pruning of running versions — both needed
  for an in-session `/restart`, which is out of scope for kimchi. The
  existing atomic in-place install already works and stays.
- **Concurrent sessions coordinating via joined installs.** Rejected in
  favour of the simpler updater lock: one winner installs, others skip —
  the in-place install covers everyone.

Consequences accepted:

- The install swaps the share directory (including bundled skills) while a
  running session may still read files from it. This is brief, already
  possible today across terminals, and accepted in exchange for keeping one
  atomic install and no launch-path work.
- A failed background update is invisible to the user; visibility comes
  from the update result and telemetry.

## Vocabulary

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
