# Codex

Kimchi ships a first-class integration for OpenAI's Codex CLI. Once configured,
Codex uses the Kimchi gateway as its model provider — so any model available on
[app.kimchi.dev](https://app.kimchi.dev) becomes a Codex model, with the same
context windows, reasoning levels, and capability flags documented in the
Kimchi UI.

## Overview

Codex is OpenAI's terminal-first coding agent. It reads its provider config
from `~/.codex/config.toml`, points at a base URL, and uses an API key pulled
from an environment variable. Kimchi plays the role of the provider:

- **Provider name**: `kimchi`
- **Base URL**: `https://llm.kimchi.dev/openai/v1`
- **API key env var**: `KIMCHI_API_KEY`
- **Wire format**: `responses` (Codex's modern API; the legacy `chat` wire is
  no longer supported and will be rejected by the gateway)

The Kimchi harness generates the Codex config (`config.toml` + `model_catalog.json`)
from your Kimchi account, so the model catalog stays in sync with the models
your API key actually has access to.

## Prerequisites

1. **Install the Codex CLI.** Follow OpenAI's install instructions — once
   installed, the `codex` binary must be on your `PATH`. Verify with:

   ```sh
   codex --version
   ```

   `kimchi setup-tools` will detect the binary and skip Codex automatically if
   it is not present.

2. **Get a Kimchi API key.** Sign in at [app.kimchi.dev](https://app.kimchi.dev)
   and create an API key. Copy it — you'll paste it into `kimchi setup-tools`
   on first run (or set `KIMCHI_API_KEY` in your shell so `setup-tools` picks
   it up automatically on subsequent runs).

## Setup via `kimchi setup-tools`

Run the interactive tool installer:

```sh
kimchi setup-tools
```

Select **Codex** from the list of supported tools. `setup-tools` will:

1. Verify the `codex` binary is on `PATH`.
2. Read your Kimchi account's model catalog.
3. Write two files into `~/.codex/`.

### What gets written

#### `~/.codex/config.toml`

```toml
model_provider = "kimchi"
model = "<slug of your resolved main model>"
model_catalog_json = "/Users/you/.codex/model_catalog.json"

[model_providers.kimchi]
name = "Kimchi Gateway"
base_url = "https://llm.kimchi.dev/openai/v1"
env_key = "KIMCHI_API_KEY"
wire_api = "responses"
```

Notes:

- `wire_api = "responses"` is required. The older `wire_api = "chat"` mode is
  no longer supported by Codex and will produce request errors against the
  Kimchi gateway. If you previously edited `config.toml` by hand and set
  `chat`, change it back to `responses` — see [Troubleshooting](#troubleshooting).
- The API key is **referenced by env var** (`env_key = "KIMCHI_API_KEY"`),
  not embedded in the file. This means `config.toml` is safe to share, and
  rotating a key never requires re-running the installer.
- If `~/.codex/config.toml` already exists (e.g. you have a `[plugins]`,
  `[features]`, `[projects]`, or `[marketplaces]` section), the installer
  strips out only the kimchi-owned keys (`model_provider`, `model`,
  `model_catalog_json`, and the `[model_providers.kimchi]` block) and
  prepends the fresh block. Your other settings are preserved.

#### `~/.codex/model_catalog.json`

A per-model capability manifest. See [Model catalog](#model-catalog) below for
the full schema and what each field controls.

## Launching Codex

`kimchi codex [args]` injects `KIMCHI_API_KEY` into the child process's
environment for that single run and forwards `args` to the `codex` binary
verbatim. Use it like the regular `codex` CLI:

```sh
# Interactive TUI with the Kimchi gateway
kimchi codex

# Non-interactive single prompt
kimchi codex exec "Refactor the auth module to use jose instead of jsonwebtoken"

# Anything else — args pass through unchanged
kimchi codex --help
kimchi codex --quiet exec "Add a CHANGELOG entry"
```

Because the API key is injected at launch time, you don't need to export
`KIMCHI_API_KEY` in your shell. If the variable is already set, the harness
uses it; otherwise the harness reads the key from the Kimchi config and
exports it for the duration of the run.

> `kimchi codex` requires a prior `kimchi setup-tools` run. The command will
> refuse to launch if Codex is not configured.

## Model catalog

`~/.codex/model_catalog.json` is the per-model capability manifest that Codex
reads at startup to populate its model picker, set the context window, and
choose reasoning defaults. Kimchi generates this file from your account's
model registry every time you run `setup-tools`, so it stays in sync with the
models your key actually has access to.

Schema:

```jsonc
{
  "models": [
    {
      "slug": "minimax-m3",                 // unique id, used in `model = "..."`
      "display_name": "MiniMax M3",
      "name": "minimax-m3",
      "model": "minimax-m3",
      "provider": "kimchi",

      "context_window": 200000,             // max input tokens
      "truncation_policy": {
        "mode": "tokens",
        "limit": 200000                     // mirrors context_window
      },

      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 10,                       // earlier models win picker ordering
      "base_instructions": "You are a helpful coding assistant.",

      "supports_tools": true,
      "supports_parallel_tool_calls": true,
      "experimental_supported_tools": [],

      // Only set on reasoning-capable models:
      "supports_reasoning_summaries": true,
      "support_verbosity": true,
      "supported_reasoning_levels": [
        { "effort": "low",    "description": "Low reasoning effort" },
        { "effort": "medium", "description": "Medium reasoning effort" },
        { "effort": "high",   "description": "High reasoning effort" }
      ]
    }
  ]
}
```

What each capability controls:

- **`context_window` / `truncation_policy.limit`** — Tokens Codex will retain
  before truncating older turns. Set from the model's Kimchi-side limit.
- **`supports_tools`** / **`supports_parallel_tool_calls`** — Whether the
  model accepts Codex's tool-calling format and whether multiple tool calls
  can run in parallel within a single turn.
- **`supports_reasoning_summaries`** / **`support_verbosity`** — Toggles
  Codex's reasoning summary UI and verbosity controls. Only enabled on
  reasoning-capable models.
- **`supported_reasoning_levels`** — The `low` / `medium` / `high` selector
  shown in the TUI. Empty on non-reasoning models.
- **`priority`** — Picker ordering. Assigned by index (`10`, `20`, `30`, ...)
  so the first model in the catalog wins by default; pass an explicit
  `--model <slug>` flag to override.

The file is auto-generated — do not hand-edit it. Re-run `kimchi setup-tools`
after upgrading your Kimchi plan or rotating models.

## Troubleshooting

The following issues all surfaced during early Codex-on-Kimchi integration.
All of them are fixed in the current release; if you see one, it usually
means a config file is stale or the backend was rolled back.

### `wire_api = "chat"` is no longer supported

**Symptom**: Codex starts but the first request fails with a wire-protocol
error from the Kimchi gateway.

**Cause**: Older setup instructions (and some hand-edited configs) used
`wire_api = "chat"`. Codex requires `wire_api = "responses"` against the
Kimchi provider.

**Fix**: Re-run `kimchi setup-tools` and select Codex. It rewrites the block
with `wire_api = "responses"`. If you have local edits you want to keep,
edit `~/.codex/config.toml` and change the value inside
`[model_providers.kimchi]` to `"responses"`.

### `namespace` tool type returns 400

**Symptom**: Codex sends a request that includes a tool whose `type` field is
`"namespace"`, and the gateway rejects it with HTTP 400.

**Cause**: Codex emits a few non-standard OpenAI tool types (notably
`namespace`) that aren't in the upstream OpenAI function-calling schema.
The Kimchi proxy now tolerates these and passes them through, but if you've
pinned an older gateway revision you'll see this error.

**Fix**: Update the Kimchi CLI to the latest release. If the error persists,
check `kimchi --version` and report the version alongside the failing
request body.

### `stream: null` is rejected by the proxy

**Symptom**: Codex sends a request with `stream: null` (rather than `true` or
omitted), and the proxy rejects the request shape.

**Cause**: Codex sometimes sends an explicit `null` for the `stream` field in
non-streaming call paths. The Kimchi proxy now normalizes `stream: null` to
the non-streaming code path, but older revisions did not.

**Fix**: Update the Kimchi CLI. The backend change ships in the same release
that added `responses` wire support.

### `reasoning_effort` is sent as a map, not a string

**Symptom**: Codex requests fail validation when `reasoning_effort` is
serialised as a JSON object instead of a string enum.

**Cause**: Some Codex builds send `reasoning_effort` as a structured object
(the same shape the OpenAI Responses API accepts), while other toolchains
expect a string. The Kimchi proxy now accepts both shapes and normalizes them
to the gateway's expected form.

**Fix**: Update the Kimchi CLI. If you're already on the latest release, run
`kimchi setup-tools` again so the generated `model_catalog.json` reflects the
current `supported_reasoning_levels` (`low` / `medium` / `high` strings).

### "Model metadata not found" warning

**Symptom**: Codex prints a warning at startup like
`Model metadata for minimax-m3 not found` and falls back to defaults
(generic context window, no reasoning controls).

**Cause**: Codex can only discover per-model capabilities when
`model_catalog_json` in `config.toml` points at a valid file. If the file is
missing, empty, or doesn't include the slug Codex is launching with, it
warns and falls back.

**Fix**: Re-run `kimchi setup-tools`. The installer regenerates both
`config.toml` (with the correct `model_catalog_json` path) and
`model_catalog.json` (with the current model list). Verify afterwards:

```sh
ls -l ~/.codex/model_catalog.json
codex --help   # warning should be gone
```

If the warning still appears, confirm the `model = "..."` value at the top
of `config.toml` matches a `slug` in the catalog JSON.

## Verifying your setup

A quick end-to-end check:

```sh
# 1. Config files exist and look right
cat ~/.codex/config.toml | grep -E 'wire_api|base_url|model_catalog_json'

# 2. Catalog is non-empty
jq '.models | length' ~/.codex/model_catalog.json

# 3. Launch and confirm the API key is injected
kimchi codex --help
```

If all three commands succeed, Codex is wired up to Kimchi and ready to use.

## See also

- [Hooks](./hooks.md) — drive Codex from Kimchi events
- [Subagents](./subagents/) — spawn Codex-style workers as kimchi subagents
- [Kimchi API key setup](https://app.kimchi.dev) — sign in and create a key
