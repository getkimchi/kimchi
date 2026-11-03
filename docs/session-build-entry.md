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
| `version` | what `kimchi --version` reports; `dev` for source runs |
| `channel` | `release`, `canary`, `dev` or `unknown` |
| `commit` | dev: full `HEAD` commit of the kimchi checkout; canary: the abbreviated commit from the version; absent for releases (resolve the `v<version>` tag) |
| `branch` | dev only; absent when `HEAD` is detached |
| `dirty` | dev only; tracked files differ from `commit` |

For dev runs, git reads the checkout kimchi runs from (`PI_PACKAGE_DIR`), not the
session's project, and ignores `GIT_DIR`/`GIT_WORK_TREE` redirection. A field git
can't answer is left out. The entry never blocks or fails a session.
