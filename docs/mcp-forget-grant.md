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

## `kimchi mcp inspect-grant`

The read-side companion: a presence-only view of one server's stored grant,
for diagnosing re-auth loops. Answers the questions that decide such a bug's
cause — which URL the grant is bound to (a mismatch with the configured server
URL is the classic stale-grant cause), whether a refresh token exists, and
when the access token expires — without ever exposing token values.

```
kimchi mcp inspect-grant <server-name> --json
→ 0: { "ok": true, "name", "found": false }
→ 0: { "ok": true, "name", "found": true, "serverUrl"?,
       "tokens"?: { "hasAccessToken", "hasRefreshToken", "expiresAt"?, "expiresInSec"?, "scope"? } }
→ 1: { "ok": false, "name", "error", "reason": "invalid-input" | "denied" | "unavailable" | "error" }
```

`serverUrl` is absent when the account record does not carry one; `tokens` is
absent when the tokens payload is missing or unreadable (a client-info-only
entry looks the same as a corrupt one). `expiresInSec` is negative when the
access token has already expired. The same name-validation rules and
`denied`/`unavailable` failure mapping as `forget-grant` apply, with one
refinement: `denied`/`unavailable` surface only from the token read; an
account that cannot be read at all (keychain unavailable or entry corrupt)
surfaces as `reason: "error"` with the forget-grant recovery hint in its
message. Consent
budget: reads go through the same keyring bridge, so a legacy item prompts at
most one dialog per invocation and a denial is tombstoned in-process.

## Why a harness-side implementation

pi-mcp-adapter has the operation internally (`removeAuthEntry`, behind its
interactive `/mcp logout`) but exports no forget verb on any public package
surface, so this is implemented over the harness's existing
`keyring-require-bridge` helpers.
