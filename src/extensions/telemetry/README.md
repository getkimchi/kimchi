# Telemetry Extension

This extension collects usage data for the Kimchi CLI and sends it via OTLP (OpenTelemetry Protocol).
All data is **best-effort** — failures are silently swallowed and never block the CLI.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ Extension hooks │────▶│ SessionContext   │────▶│ OTLP Logs   │
│ (pi-coding-agent)│     │ + CumulativeState│     │ + Metrics   │
└─────────────────┘     └──────────────────┘     └─────────────┘
         │
         └── pre-session.ts  (CLI-level events, no session yet)
```

| Component | Purpose |
|-----------|---------|
| `index.ts` | Extension entry — binds pi-coding-agent hooks to handlers |
| `session-context.ts` | Per-session state, batching, flush timers, drain |
| `pre-session.ts` | Events that fire before the agent session exists |
| `accumulator.ts` | Cumulative counters flushed as OTLP Sum metrics |
| `transport.ts` | HTTP senders for OTLP Logs and OTLP Metrics |
| `helpers.ts` | Language inference, line counting, attr builders |
| `handlers/` | Event-specific logic (messages, tools, session) |

## Common Attributes

Every in-session payload includes:

| Attribute | Value |
|-----------|-------|
| `session.id` | Shared root UUID across all agents in the process |
| `client` | `"pi"` |
| `source` | Where the event originated (e.g. `"cli"`) |
| `mode` | `"coding"` or `"ferment"` |

Pre-session payloads use the **device ID** (from PostHog) as `session.id`.

## Pre-Session Events

Fired from `pre-session.ts` via `sendPreSessionEvent()`. Sent to the **logs endpoint**.

| Event | When | Attributes |
|-------|------|------------|
| `app_started` | CLI binary starts | `subcommand` |
| `harness_launched` | Agent harness launched | `version` |
| `setup_aborted` | Setup wizard cancelled | `step` |
| `tool_configured` | Tool enabled in setup wizard | `tool_name` |
| `setup_completed` | Setup wizard finished | `tools_count`, `scope` |

All pre-session events also carry base resource attributes: `telemetry.cli_version`, `telemetry.os`, `telemetry.arch`, and optionally `user.account_uuid` / `userEmail`.

## In-Session Log Events

Fired from `session-context.ts` via `ctx.emit()`. Batched (max 20) and flushed every 5s. Also sent to the **logs endpoint**.

| Event | When | Attributes |
|-------|------|------------|
| `session.start` | Session begins | `model` |
| `session.end` | Session ends | `model`, `duration_ms`, `ended_by`, `source`, `mode` |
| `user_message` | User sends a message | `model`, `message_length` |
| `api_request` | Assistant response completes | `model`, `provider`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `duration_ms` |
| `tool_result` | Any tool finishes | `tool_name`, `model`, `success`, `duration_ms` |
| `file_read` | `read` tool succeeds | `model`, `language`, `file_hash`, `duration_ms` |
| `file_written` | `write` tool succeeds | `model`, `language`, `file_hash`, `lines_added`, `duration_ms` |
| `file_edited` | `edit` / `multiedit` / `patch` succeed | `model`, `language`, `file_hash`, `lines_added`, `lines_deleted`, `duration_ms` |
| `command_executed` | `bash` tool runs | `model`, `command_type`, `exit_code`, `duration_ms` |
| `error` | Agent or tool error | `model`, `error_type` (`agent_error` / `tool_failure`), `error_message` *(truncated to 300 chars)* |
| `subagent.spawned` | Sub-agent created | `model`, `agent_type`, `reason` |

## Cumulative Metrics (OTLP Sum)

Accumulated across the whole session and flushed every 30s to the **metrics endpoint**.

| Metric Name | Type | Description | Attributes |
|-------------|------|-------------|------------|
| `claude_code.token.usage` | Sum | Token consumption | `type` (`input` / `output` / `cacheRead` / `cacheCreation`), `model` |
| `claude_code.cost.usage` | Sum | Cost in USD | `model` |
| `claude_code.commit.count` | Sum | Git commits detected | `tool_name`, `decision` |
| `claude_code.pull_request.count` | Sum | PR creations detected (`gh pr create`) | `tool_name`, `decision` |
| `claude_code.lines_of_code.count` | Sum | Lines added or removed | `type` (`added` / `removed`), `language` |
| `claude_code.tool.usage` | Sum | Tool invocation count | `tool_name` |
| `claude_code.tool.duration_ms` | Sum | Total tool execution time (ms) | `tool_name` |
| `claude_code.code_edit_tool.decision` | Sum | Edit tool decisions by language | `tool_name`, `decision`, `language`, `source` |

### `editDecisions` Key Format

The accumulator stores edit decisions under a pipe-delimited key:

```
{toolName}|accept|{language}|auto
```

Example: `write|accept|TypeScript|auto`

## Transport Details

| Setting | Value |
|---------|-------|
| Log batch max size | 20 records |
| Log flush interval | 5 000 ms |
| Metrics flush interval | 30 000 ms |
| Drain timeout | 5 000 ms (in-session) / 3 000 ms (pre-session) |
| Resource attributes | `service.name="kimchi"`, `user_agent.original="kimchi/{version}"` |
| Scope | `name="kimchi"`, `version="1.0.0"` |
| Endpoints | `config.endpoint` (logs), `config.metricsEndpoint` (metrics) |

## Privacy Notes

- **File paths are hashed** (SHA-256, first 12 chars) before being sent as `file_hash`.
- **No prompt content or file contents** are transmitted.
- Telemetry is opt-in and controlled by `telemetry.enabled` in `~/.config/kimchi/config.json` (overridable via `$KIMCHI_TELEMETRY_ENABLED`).
