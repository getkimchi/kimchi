# OAuth token migration (adapter → native)

When a user upgrades to the native MCP engine, their pi-mcp-adapter OAuth
credentials are imported into the native `mcp-auth.json` store **automatically
and transparently** — no re-login is needed, no command has to be run.

## When it runs

- **First launch after the upgrade** (entry.ts, before the native MCP
  extension reads its config): a one-shot import for every http server in
  `<agentDir>/mcp.json` and the start cwd's `.kimchi/mcp.json`. Guarded by a
  stamp (`<agentDir>/mcp-oauth-import.done`) and the same O_EXCL lock
  discipline as the config migration; idempotent.
- **Per new project** (the MCP extension, when a session first sees a cwd its
  project file was not migrated in): the same import for that project's
  servers — the launch-time pass only covers the start cwd.

## What is read

The adapter stores, read-only, first valid entry per server:

1. OS keyring: service `pi-mcp-adapter.oauth`, account `sha256-<sha256hex(name)>`,
   chunked values (>1000 chars) reassembled from
   `<account>.chunk.<digest>.<index>` accounts.
   - macOS: `security find-generic-password` — silent for release binaries
     (same Developer ID as the writer); an ad-hoc/dev build may get a one-time
     consent prompt. Reads are timeout-bounded (10s) and a hard failure
     disables further keyring reads for that launch.
   - Linux: `secret-tool lookup` (install `libsecret-tools` if absent).
   - Windows Credential Manager: not implemented — those servers fall back to
     the re-login notice.
2. Legacy plaintext: `<agentDir>/mcp-oauth/<account>/tokens.json`.
3. Opt-in encrypted file: `<agentDir>/mcp-oauth-encrypted/<account>/credentials.json`
   (AES-256-GCM; requires `PI_MCP_ADAPTER_OAUTH_FILE_KEY`).

## What is written

Native grants in `<agentDir>/mcp-auth.json`, keyed
`mcp__<name with - replaced by _>|<normalized url>`, with adapter fields
mapped onto the native state (tokens, expiry seconds → milliseconds, client
registration). Atomic 0600 writes; existing native keys are never modified.

## Failure behavior

- The stamp is only written when the import finished without warnings — an
  environment that was not ready (missing `secret-tool`, a dismissed keychain
  prompt) retries on the next launch. Warnings are printed to stderr.
- A server whose adapter entry is stale by the adapter's own rule (missing or
  changed `serverUrl`) is skipped and reported.
- Any failure degrades to the pre-existing behavior: the server 401s on first
  use and the native engine starts its OAuth flow. A bad import can never be
  worse than a re-login.
- The post-migration "sign in again" notice only lists servers that did **not**
  end up with a native grant.

## Safety properties

- Adapter stores are left untouched — rolling back to a v1.16.0 binary keeps
  its credentials working.
- A migrated grant the server has since revoked produces a 401 on first use;
  the native engine then runs its normal OAuth flow.
