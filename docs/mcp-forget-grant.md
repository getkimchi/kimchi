# `kimchi mcp forget-grant`

One-shot "forget this server's OAuth grant" operation. Kimchi Studio runs it at
connector disconnect time (Granola, Pylon) so reconnecting starts a fresh
sign-in instead of reusing the previous grant.

## Invocation contract

```
kimchi mcp forget-grant <server-name> --json
→ 0: { "ok": true,  "name", "removed": N }
→ 1: { "ok": false, "name", "error", "reason": "invalid-input" | "error" }
```

`removed` is the number of native-store entries deleted; `removed: 0` means
there was nothing to forget. Both are exit 0.

## What is deleted

Post-migration, OAuth credentials live in `<agentDir>/mcp-auth.json` (pi's native
file store; no OS keychain involvement). Keys are namespaced per server as
`mcp__<name with - replaced by _>|<url>` (pi's `mcpNamespace`), with a legacy
bare-URL key from pi's own migration. forget-grant deletes every key carrying
the server's namespace, so the grant is forgotten across all URL variants of
that server; bare-URL legacy keys carry no server name and are left alone.

## Migration-era behavior change

Before pi 1.3's native MCP, credentials lived in OS keychain entries plus a
legacy plaintext directory, and forgetting involved macOS keychain consent
dialogs (hence the old `denied` / `unavailable` reasons). Those failure modes
no longer exist; callers that mapped them should treat any `reason` other than
`invalid-input` as a generic error.
