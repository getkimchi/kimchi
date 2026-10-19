# `kimchi mcp import-auth`

One-shot import of pi-mcp-adapter OAuth credentials into the native
`mcp-auth.json` store, so upgrading to the native MCP engine does not force a
re-login per OAuth server. Run it once after upgrading; it is idempotent and
re-runnable.

## Invocation contract

```
kimchi mcp import-auth [--json]
→ 0: report (see below) — including "nothing to import"
→ 1: { "ok": false, "error" }   (unexpected arguments, unreadable mcp-auth.json)
```

The `--json` report:

```json
{
	"ok": true,
	"imported": ["server-a"],
	"results": [
		{ "name": "server-a", "status": "imported", "store": "keyring" },
		{ "name": "server-b", "status": "already-authenticated" },
		{ "name": "server-c", "status": "no-adapter-credentials" },
		{ "name": "server-d", "status": "url-mismatch", "detail": "…" }
	],
	"warnings": []
}
```

Statuses: `imported`, `already-authenticated` (native grant exists — never
clobbered), `no-adapter-credentials`, `url-mismatch` (stale by the adapter's
own `getAuthForUrl` rule), `invalid-entry`.

## What is read

Servers with a `url` from `<agentDir>/mcp.json` and, when present, the current
directory's `.kimchi/mcp.json` (project config wins on name collisions). For
each, the adapter stores are read **read-only**, in this order — first valid
entry wins:

1. OS keyring: service `pi-mcp-adapter.oauth`, account
   `sha256-<sha256hex(name)>`, chunked values (>1000 chars) reassembled from
   `<account>.chunk.<digest>.<index>` accounts.
   - macOS: `security find-generic-password` (a keychain consent prompt is
     possible the first time).
   - Linux: `secret-tool lookup` (install `libsecret-tools` if absent; the
     command warns and falls through to the file stores).
   - Windows: not implemented — run `kimchi mcp login <server>` once instead.
2. Legacy plaintext: `<agentDir>/mcp-oauth/<account>/tokens.json`.
3. Opt-in encrypted file: `<agentDir>/mcp-oauth-encrypted/<account>/credentials.json`
   (AES-256-GCM; requires `PI_MCP_ADAPTER_OAUTH_FILE_KEY` to hold the 32-byte
   base64 key).

## What is written

Native grants in `<agentDir>/mcp-auth.json`, keyed
`mcp__<name with - replaced by _>|<normalized url>`, with the adapter fields
mapped onto the native state (tokens, expiry seconds → milliseconds, client
registration). The file is rewritten atomically with 0600 permissions; existing
native keys are never modified.

## Safety properties

- Adapter stores are left untouched — rolling back to a v1.16.0 binary keeps
  its credentials working.
- A migrated grant that the server has since revoked simply produces a 401 on
  first use; the native engine then starts its normal OAuth flow. A bad import
  degrades to today's behavior, never worse.
- After a successful import, the post-migration "sign in again" notice no
  longer lists servers that hold a native grant.
