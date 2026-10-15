# `kimchi mcp forget-grant`

One-shot "forget this server's OAuth grant" operation. Kimchi Studio runs it at
connector disconnect time (Granola, Pylon) so reconnecting starts a fresh
sign-in instead of reusing the previous grant.

## Invocation contract

```
kimchi mcp forget-grant <server-name> --json
→ 0: { "ok": true,  "name", "found", "chunksRemoved", "legacyFileRemoved" }
→ 1: { "ok": false, "name", "error", "reason": "invalid-input" | "denied" | "unavailable" | "error" }
```

`found: true` means a grant existed and was removed; `found: false` means there
was nothing to forget. Both are exit 0. `reason: "denied"` means the user
declined the macOS keychain consent dialog — do not retry; `unavailable` means
a locked keychain.

## What is deleted

For the server name, using the same `sha256-<sha256(name)>` account key the
pi-mcp-adapter OAuth writer uses (`mcpCredentialAccountId`):

- the keychain entry under `dev.kimchi.mcp.oauth`
- its chunk entries `<account>.chunk.<digest>.<index>`
- the legacy plaintext entry `<oauthDir>/<account>/` (otherwise the next start
  re-imports it into the keychain and the grant survives the forget)

## Consent budget

macOS may show **at most one consent dialog per invocation**, and only for
items whose ACL does not trust `/usr/bin/security` (legacy items written
in-process). How the budget is kept:

- The operation never reads the keychain on macOS. Chunk accounts are
  discovered by enumerating the service's entries (`dump-keychain`), so a
  legacy item never triggers the read-path ACL self-heal, which would show its
  own dialog. Enumeration also finds chunks when the main entry is corrupt.
  A failed dump is itself a failure (`reason: "unavailable"`), never a reason
  to start reading. Where enumeration is not possible (non-macOS), chunk keys
  come from the manifest inside the main entry, and a corrupt main is
  forgotten alone.
- The delete loop aborts on the first denial instead of trying every entry,
  which would show a fresh dialog per legacy item. The thrown
  `McpKeychainDeniedError` becomes `reason: "denied"` at the CLI.
- Within a process, a read-path denial is tombstoned (see
  `keyring-require-bridge.ts`), so repeat calls in one process cannot
  re-prompt. Across invocations the caller is expected to honor `denied`.

## Why a harness-side implementation

pi-mcp-adapter has the operation internally (`removeAuthEntry`, behind its
interactive `/mcp logout`) but exports no forget verb on any public package
surface, so this is implemented over the harness's existing
`keyring-require-bridge` helpers.
