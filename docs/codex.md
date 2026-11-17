# Codex setup

Run `kimchi setup-tools` and select **Codex**. Kimchi uses its configured API key and the current organization model feed to generate:

- `~/.codex/config.toml`
- `~/.codex/model_catalog.json`

No TOML editing, `KIMCHI_API_KEY` export, or Codex daemon restart is required. Start Codex with either `codex` or `kimchi codex` and choose models through Codex's normal picker.

## Credentials and defaults

Without a ChatGPT login, Kimchi writes the `kimchi` provider and makes it the default. Its static `Authorization` Bearer header authenticates ordinary, non-subscription feed models. Subscription-only rows are not added to the catalogue because they cannot serve requests without ChatGPT OAuth.

To include ChatGPT subscription models, run `codex login` before `kimchi setup-tools`. Kimchi detects an existing ChatGPT login in `~/.codex/auth.json`; it does not start a login flow or copy OAuth tokens into the generated TOML. Missing, malformed, or non-ChatGPT auth data leaves the API-key-only setup in place.

When a usable ChatGPT login and supported subscription feed rows are present, Kimchi writes both `kimchi` and `kimchi_chatgpt` providers and defaults to `kimchi_chatgpt`. That provider combines the ChatGPT Bearer login with a static `X-API-Key` header. The Kimchi key authenticates every request and selects the organization; ChatGPT OAuth supplies the upstream credential for subscription models. The same default therefore serves both ordinary and subscription models, and switching models in the picker requires no provider or profile changes.

The catalogue comes from the organization feed on each setup run. Unsupported ChatGPT entries are filtered out and duplicate slugs are emitted only once. The API key is stored in the generated user-local `config.toml` as a static header, including in both provider blocks when dual credentials are configured.

## Refreshing the catalogue

The generated catalogue is a point-in-time snapshot. Feed additions, removals, and metadata changes do not propagate in the background, and neither `codex` nor `kimchi codex` refreshes it.

Re-run `kimchi setup-tools`, select Codex, and open a new Codex session to load the latest feed. Re-running setup replaces the generated provider blocks and catalogue without duplicating entries and preserves user-owned Codex configuration. No daemon restart is needed.

## Desktop app and IDE limitations

Environment inheritance for the ChatGPT desktop app and IDE extensions is not configured by this flow. Their launch environment and restart behavior remain platform-specific; this setup configures the Codex CLI configuration files only.
