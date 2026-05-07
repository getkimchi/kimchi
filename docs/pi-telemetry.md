# Pi Telemetry Extension

Ports the opencode-kimchi OTLP telemetry pattern to the Pi coding agent. Sends API request logs and productivity metrics to Kimchi.

## Location

`~/.pi/agent/extensions/telemetry.ts` — loaded by Pi at runtime, no build step.

## Config

`~/.pi/telemetry.json` (file is base; env vars override individual keys):

```json
{
  "enabled": true,
  "endpoint": "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
  "metricsEndpoint": "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
  "headers": {
    "Authorization": "Bearer <api-key>"
  }
}
```

Env var overrides: `PI_ENABLE_TELEMETRY`, `PI_OTLP_ENDPOINT`, `PI_OTLP_METRICS_ENDPOINT`, `PI_OTLP_HEADERS`.

## Data Sent

### Logs (`endpoint`)

One OTLP log record per completed assistant message:

| Attribute | Value |
|---|---|
| `event.name` | `api_request` |
| `client` | `pi` |
| `service.name` | `pi` |
| `session.id` | UUID per session |
| `model` | model ID string |
| `provider` | provider string |
| `input_tokens` | input token count |
| `output_tokens` | output token count |
| `cache_read_tokens` | cache read tokens |
| `cache_creation_tokens` | cache write tokens |
| `cost_usd` | total message cost |
| `session_uptime_ms` | wall time since session start |

### Metrics (`metricsEndpoint`)

Cumulative OTLP Sum metrics flushed every 30s and on shutdown. All metrics include `client=pi` and `session.id` attributes.

| Metric | Extra Attributes | Source |
|---|---|---|
| `claude_code.token.usage` | `type` (input/output/cacheRead/cacheCreation), `model` | `message_end` |
| `claude_code.cost.usage` | `model` | `message_end` |
| `claude_code.commit.count` | — | bash `git commit` regex |
| `claude_code.pull_request.count` | — | bash `gh pr create` regex |
| `claude_code.lines_of_code.count` | `type` (added/removed) | edit/write/multiedit tools |
| `claude_code.code_edit_tool.decision` | `tool_name`, `language`, `decision=accept`, `source=auto` | edit/write/multiedit tools |

## Pi Event Mapping

| Pi event | Action |
|---|---|
| `session_start` | Reset all state, generate new `session.id` UUID |
| `message_end` | Send log record, accumulate token/cost metrics |
| `tool_execution_start` | Buffer tool args by `toolCallId` |
| `tool_execution_end` | Consume buffered args; track bash/edit/write/multiedit |
| `session_shutdown` + SIGINT | Flush metrics, clear timer |

**Note:** Pi's `tool_execution_end` event does not include tool args — they are captured from `tool_execution_start` and buffered in a `Map<toolCallId, {toolName, args}>`.

## Reference

- Spec: `docs/superpowers/specs/2026-04-09-pi-telemetry-design.md`
- Plan: `docs/superpowers/plans/2026-04-09-pi-telemetry.md`
- Upstream reference: [castai/opencode-kimchi PR #1](https://github.com/castai/opencode-kimchi/pull/1)
- Kimchi plugin docs: [castai/opencode-otel-plugin](https://github.com/castai/opencode-otel-plugin)
