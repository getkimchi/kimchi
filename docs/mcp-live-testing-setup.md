# Live MCP OAuth testing setup

How to provision and operate the two live MCP OAuth checks that talk to real providers:

- `scripts/mcp-live-probe.mjs` — credential-free authorize-URL check (runs on pull requests; see [mcp-e2e-testing.md](mcp-e2e-testing.md)).
- `scripts/mcp-live-google-lifecycle.mjs` — credentialed silent-renewal check against Google (manual dispatch only).

Both scripts print booleans, tool counts, and expiry timestamps. Refresh tokens and client secrets never appear in their output.

## Provider inventory for the authorize-URL check

The provider inventory comes from the `MCP_LIVE_PROVIDERS` repository secret — a JSON array of provider entries (shape in the script header): one per OAuth MCP server worth watching, each with its expected redirect-URI class and whether it is Google-backed. Keep internal server names and client identifiers in the secret, never in this repository. Entry names do appear in workflow logs and the uploaded matrix; if the inventory itself is sensitive, choose non-revealing names.

Fork pull requests see no secrets and the live step is skipped entirely; the `skip-live-mcp` label skips it during a provider outage.

## Google test account and OAuth app

The lifecycle check needs a **dedicated test Google account** — not a staff account — with only `gmail.readonly` granted, used solely against a test mailbox. Create an OAuth app for it in the Google Cloud console:

- Prefer an **Internal** app under your Workspace: refresh tokens for internal apps do not expire on a schedule.
- A **Testing** app works, but Google expires its refresh tokens after 7 days — the stored token must be re-seeded weekly (below), and the nightly schedule is not worth enabling in that mode.
- Register both loopback redirect URIs the harness sends: `http://localhost:19876/callback` and `http://127.0.0.1:19876/callback`.

Store three repository secrets:

| Secret | Value |
| --- | --- |
| `GOOGLE_MCP_TEST_CLIENT_ID` | the app's OAuth client id |
| `GOOGLE_MCP_TEST_CLIENT_SECRET` | the app's OAuth client secret |
| `GOOGLE_MCP_TEST_REFRESH_TOKEN_GMAIL` | a refresh token for the test account (below) |

## Seeding the refresh token

One-time setup, repeated on rotation:

1. Build the branch under test: `pnpm run build:binary`.
2. Create an isolated home with the server pre-configured (the `/mcp` panel is view-only; kimchi's user-global MCP config is `~/.config/kimchi/harness/mcp.json` — passed to the adapter as the default configPath, so `mcp-adapter.json` is not read) and a file-backed credential store (the store switches on `KIMCHI_MCP_E2E_KEYRING_DIR` alone — no OS keychain is touched):

   ```sh
   mkdir -p /tmp/gmail-seed/.config/kimchi/harness
   cat > /tmp/gmail-seed/.config/kimchi/harness/mcp.json <<'EOF'
   {
     "mcpServers": {
       "gmail": {
         "url": "https://gmailmcp.googleapis.com/mcp/v1",
         "auth": "oauth",
         "oauth": { "clientId": "<client id>", "clientSecret": "<client secret>" }
       }
     }
   }
   EOF
   HOME=/tmp/gmail-seed KIMCHI_MCP_E2E_KEYRING_DIR=/tmp/gmail-seed/mcp-keyring dist/bin/kimchi
   ```

3. In the session: run `/mcp-auth gmail` and complete the Google consent in the browser that opens. Completing it proves the acceptance criterion the scheduled check cannot: a refresh token is issued on **first consent**, because the authorize URL carried `access_type=offline`. The credential lands in `$HOME/mcp-keyring/`.

4. Extract the refresh token from the stored entry JSON (`tokens.refreshToken`) and save it as the `GOOGLE_MCP_TEST_REFRESH_TOKEN_GMAIL` secret. Delete the temporary home directory afterwards — its config file holds the client secret.

The extraction step is manual by design: the token passes from your screen to the secret store without transiting the repository or any log.

## Running the checks

```sh
# authorize-URL check (needs MCP_LIVE_PROVIDERS and a built binary)
pnpm run test:e2e:mcp:live

# Google renewal check (needs the GOOGLE_MCP_TEST_* variables below)
node scripts/mcp-live-google-lifecycle.mjs
```

Locally, the renewal check reads `GOOGLE_MCP_TEST_CLIENT_ID`, `GOOGLE_MCP_TEST_CLIENT_SECRET`, `GOOGLE_MCP_TEST_REFRESH_TOKEN`, and optionally `GOOGLE_MCP_TEST_SERVER`/`GOOGLE_MCP_TEST_ISSUER`. In the workflow, the per-server secrets (`GOOGLE_MCP_TEST_REFRESH_TOKEN_GMAIL`, `_DRIVE`, `_CALENDAR`) are mapped onto `GOOGLE_MCP_TEST_REFRESH_TOKEN` for the selected server; dispatching Drive or Calendar without its secret fails fast with a clear "not set" error.

Or dispatch the `MCP live lifecycle` workflow, choosing Gmail, Drive, or Calendar (only Gmail is provisioned by default).

## Triage

- **Browser consent opened / tools empty**: renewal is broken — check the offline-access handling in the OAuth stack before anything else.
- **`invalid_grant`**: the refresh token was revoked or expired (7-day expiry for Testing apps) — re-seed it.
- **authorize-URL failures in the pull-request check**: the redirect-URI registration or the authorize-URL construction drifted — compare the failing entry's `redirect_uri` against the app's registered URIs.
- **Provider 5xx or network errors**: retried once automatically; a persistent failure is a provider outage — label the pull request `skip-live-mcp` and file it.
