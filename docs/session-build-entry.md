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
`0.0.0` version. Git then reads that checkout (the harness, not the session's
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

Build info is resolved once per process. On a failure it's tried again at the
next `session_start`. The `session_start` handler doesn't wait for it: the entry is
appended when git answers (at most 2 s per git call), so it may come a few
entries after `session_start`, and session startup never waits on git. A field
git can't answer is left out. If the session is replaced before the answer
arrives, no entry is written for it; its successor gets its own.
