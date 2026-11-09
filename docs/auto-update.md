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
updates themselves. The gate is `ctx.mode === "tui"`, because `ctx.hasUI` is
also true in RPC, which is how ACP binds extensions.

One tick (`runUpdateTick`, `src/update/background.ts`):

1. **Take the updater lock.** If another session holds it, the tick returns
   `skipped-lock` and persists nothing — the winner records the meaningful
   outcome, and a lock-less write could clobber the winner's record.
2. **Check** GitHub releases via `checkForUpdate`, honoring the shared
   30-minute cache, so N open sessions still mean at most one check per
   machine per 30 minutes.
3. **Dedup** against the last-installed release tag written by any session,
   confirmed against the version of the installed files: a session that
   installed stays on its old version at runtime (the install applies to the
   *next* launch), so without this record concurrent sessions would reinstall
   the same release every tick. The files on disk win over the record, so an
   external install of an older version can't block a release. A canary on
   disk is never replaced, even by a stable session that was already open.
4. **Install** via `applyUpdate` — download → checksum → extract →
   smoke-test → atomic in-place rename. Binary *and* share dir
   (`vendor`/`bridge`) swap mid-session; Windows rotates `kimchi.exe.old`.
5. **Record** the outcome (the update result) and, after a successful
   install, the last-installed tag — both persisted while the lock is still
   held.

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

The only thing ever shown is one line on the status bar, once the installed
version is newer than the one this session is running:

```text
✔ Update installed · Restart to update
```

Every session on the old version shows it, not just the one that installed.
It comes from the version of the installed files, checked at session start,
after each tick and once a minute, so other sessions pick it up within a minute
and it survives `/new`, `/resume` and `/fork`. The minute check is a single file
read, with no lock or network. Ticks alone would miss sessions started together:
the one that loses the lock reads the old version just before the install ends.

No progress while checking or downloading, no failure messages, no
release-note summary at the next launch. Opt-out users (auto-update off, or
Homebrew) keep the existing `Update available! Run kimchi update` /
`brew upgrade kimchi` nag.

## Failures

A failed tick is invisible by design. It is written to the **update result**
file `~/.cache/kimchi/update-result.json` and retried plainly on the next
30-minute tick — no backoff, and a later success simply replaces the failed
state.

The updater lock carries the holder's pid, timestamp, and a random ownership
nonce. The holder heartbeats its timestamp every 5 minutes, so a long
install (or a user thinking at the `kimchi update` prompt) can't age past
the staleness escape. The escape itself — a 15-minute staleness window —
stills exists for kill -9, where the OS can recycle the owner's pid and make
a dead holder look alive. Release only deletes its own lock (nonce match),
so a holder whose lock was stolen cannot evict the usurper. Takeover renames
the stale file aside and compares it to what was judged stale, so a session
racing the same takeover cannot evict the winner either. A kill mid-copy
can leave a mixed install (new binary, stale share) that nothing recorded;
the design accepts this: the residual window is seconds, and the next
successful update repairs it.

## Manual update

`kimchi update` (and `/update` → "Update kimchi now") works as before and
remains the way to update immediately, with two differences: it takes the
updater lock like ticks do and refuses while an install is in progress —
two concurrent installers would race on the share-directory swap. If the lock
file can't be written at all (a read-only or root-owned cache), it goes ahead
without the lock rather than reporting an install that isn't happening. And a
successful install records the last-installed tag, so other sessions (and
this session's next tick) dedup the release instead of reinstalling it.
`/update` applies the same dedup, so it doesn't reinstall a release a tick
already installed, but only when the record and the installed files agree: it
stays usable for repairing an install the record no longer describes.

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
- Codesign and the smoke test run asynchronously, with a timeout, so they don't
  stall the TUI. The swap and share-directory copy stay synchronous, which can
  stall it briefly, because yielding there would let a quit leave a new binary
  without its share directory.
- A failed background update is invisible to the user; visibility comes
  from the update result file.
- Diagnostics keep their own files (`update-result.json`,
  `last-installed.json`) beside the shared check cache (`state.json`),
  because the cache's unlocked read-modify-write saves race too often to
  trust them with records written under the updater lock.

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
A session that finds it held skips its tick. Keyed by pid + nonce, kept
fresh by a heartbeat, taken over only after a staleness window.
_Avoid_: mutex, install lock

**Update result**:
The recorded outcome of the most recent background tick that ran
(skipped-lock ticks record nothing), kept for diagnosis because a failed
background update is never shown to the user.
_Avoid_: log, error state

**Update notice**:
The quiet status-line message about update state. Only an outcome
("✔ Update installed · Restart to update") is ever shown, in every session
still on the old version — never progress, never failures.
_Avoid_: progress indicator, toast

**Auto-update notice**:
The one-time, persistent announcement that auto-update is on by default and
how to opt out. It must have been shown before any update may install.
_Avoid_: consent gate, opt-in banner
