# Session build entry (`kimchi_build`)

Every `session_start` appends a `kimchi_build` custom entry to the session JSONL
recording which harness build ran it (`src/extensions/build-info.ts`). A resumed
session gets a new entry, so each segment of a session names its own build. The
upstream session header (`{"type":"session","version":3,...}`) carries only the
session-format version.

Consumers (offline trace analysis, such as `getkimchi/self-improvement`) use it to
check whether an issue seen in a session is already fixed on master, or has come
back after a fix.

```json
{"type":"custom","customType":"kimchi_build","data":{"schemaVersion":1,"version":"dev","channel":"dev","commit":"e8dd4fb5…","branch":"master","dirty":false}}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `version` | the release or canary version; `dev` for any run from a source checkout |
| `channel` | `release`, `canary`, `dev` or `unknown` |
| `commit` | dev: full `HEAD` commit of the kimchi checkout; canary: the abbreviated commit from the version; absent for releases (resolve the `v<version>` tag) |
| `branch` | dev only; absent when `HEAD` is detached |
| `dirty` | dev only; tracked files differ from `commit` (untracked files are ignored) |

## Source runs

A run counts as `dev` when the code is loaded from a kimchi source checkout: the
checkout root (`SOURCE_ROOT` in `src/utils.ts`, resolved from the module's own
location) holds the `@kimchi-dev/cli` `package.json` with the unreleased
`0.0.0` version. That constant is load-bearing: real versions are stamped at
build time in CI (canary as `0.0.0-canary.<date>.<sha>`, releases from the tag
via `scripts/set-version.js`), so the in-tree version must stay `0.0.0` — a
committed bump would misclassify every source run from that tree as a
`release`, losing commit/branch/dirty and naming a version whose tag may not
exist. Git then reads that checkout (the harness, not the session's
project), with every `GIT_*` variable removed from its environment so nothing
redirects it.

The detection (`detectVersion`/`getDetectedVersion` in `src/utils.ts`) doesn't
use `PI_PACKAGE_DIR` or `getVersion()`. When the checkout's resources aren't
built, `entry.ts` points the package dir at an installed release's share dir,
and `kimchi --version` then reports that release (e.g. `1.27.0`) even though
the code is running from source. The entry records `dev` in that case — and so
does telemetry: `telemetry.cli_version` and the OTLP resource attribute
`user_agent.original` report `getDetectedVersion()`, the same value as this
entry's `version` field.

## Timing and failures

Build info is resolved once per process. A rejected resolve is tried again at
the next `session_start`, and so is a partial one: when a git read fails the
entry is still written with the fields git did answer (a field git can't
answer is left out), but it isn't cached — the next `session_start` retries
git. A complete entry is cached. A detached HEAD is a complete answer — the
branch read succeeded, git answered `HEAD` — while a failed branch read marks
the answer partial, so later sessions retry it. The `session_start` handler
doesn't wait for the resolve: the entry is appended when git answers (at most
2 s per git call), so it may come a few entries after `session_start`, and
session startup never waits on git. A `session_shutdown` handler holds the
shutdown until the pending append settles, so a short-lived session still
gets its entry — the ACP server awaits shutdown handlers before disposing
the session. A session replaced before the answer arrives (its ctx is
invalidated without an awaited shutdown) gets no entry; its successor gets
its own.
