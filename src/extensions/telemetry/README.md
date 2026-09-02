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
| `session.id` | Per-process telemetry session id — shared by the main agent and in-process subagents, so events roll up under one backend session; not a per-agent id, and out-of-process agents (remote, session-review subprocesses) have their own |
| `session.parent_id` | Spawning (parent) session's pi session id — present only on events emitted from inside a subagent run |
| `client` | `"pi"` |
| `source` | Where the event originated (e.g. `"cli"`) |
| `mode` | `"coding"` or `"ferment"` |

Pre-session payloads use the **device ID** (from PostHog) as `session.id`.

### Subagent identification

`session.parent_id` is the marker for events raised inside a subagent run. It
is emitted only when the process is inside an Agent-subagent execution
(`isAgentWorker()` — the Agent-worker async context, or `KIMCHI_SUBAGENT=1`)
*and* the runner has recorded the spawning session (`KIMCHI_PARENT_SESSION_ID`,
set for the whole subagent run by `withParentSessionEnv` in
`extensions/agents/manager/agent-runner.ts`). Its value is the **parent**
session's pi session id; the emitting session's own id is `pi_session_id`.
Combine the two to reconstruct the spawn tree:

| Attribute | Main agent event | In-process subagent event |
|-----------|------------------|---------------------------|
| `session.id` | process telemetryId `T` | `T` (shared — same process) |
| `pi_session_id` | parent session id `P` | subagent session id `S` |
| `session.parent_id` | *(absent)* | `P` |

An event with `session.parent_id != ""` whose `session.id` equals the
parent's is from an **in-process** subagent (same process — the main agent and
its in-process subagents share the module-level telemetryId). Two caveats:

- The **curator session-review subprocess** also sets `KIMCHI_SUBAGENT=1` and
  `KIMCHI_PARENT_SESSION_ID`, so its events carry `session.parent_id` too. It
  is a separate process, so it is distinguished by its own `session.id`
  (different from the parent's telemetryId).
- **Remote sandbox agents** never receive the env var, so their events carry
  no `session.parent_id`.

`subagent.spawned` (raised by the *parent*) additionally declares the
subagent's `agent_type` and `reason`, so spawning events can be paired with
the subagent's own events via `session.parent_id`.

Provider requests issued inside a subagent run also carry an
`X-Parent-Session-Id` header (same value and gating as `session.parent_id`) so
the proxy can record the parent session on `chat_completions` rows, mirroring
how it already records `X-Session-Id` / `X-Turn-Index`.

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
| `error` | Agent, tool, or transport error | `model`, `error_type` (`agent_error` / `tool_failure` / `transport_error`), `error_message` *(truncated to 300 chars)* |
| `subagent.spawned` | Sub-agent created | `model`, `agent_type`, `reason` |
| `loop_guard.warn` | Loop-guard issues a steer | `model`, `detector`, `count`, `is_subagent` |
| `loop_guard.subagent_abort` | Subagent terminated after a loop-guard steer | `model`, `detector`, `count`, `is_subagent` |

> **Privacy:** Loop-guard events carry only structured fields — `detector` (which loop detector fired), `count` (per-session warn count), and `is_subagent`. Raw tool args, command text, and the human-readable reason string are intentionally **not** emitted, to avoid leaking user data or secrets.

## Workflow Events

Published by `@kimchi-dev/kimchi-workflows` on the **single** pi.events channel `workflow:telemetry` (an envelope: every payload carries an `event` discriminator), translated here by one handler (`handlers/workflows.ts`). The OTLP name is a mechanical derivation — `workflow.` + `event` with `_` → `.` — and payload fields pass through as attributes unchanged (minus `event`). Object-valued fields are flattened generically, one level, into dotted attributes: the error envelope `error: { message }` becomes `error.message`, and envelope fields the producer adds later (`error.retryable`, `error.kind`) ship with no change here. Unknown `event` values are forwarded the same way, so producer-side additions ship without a change here. The canonical contract (channel, event types, payload shapes) lives in the producer's `src/host/telemetry-events.ts`; `workflow-events.ts` here is a mirror.

Common attributes: `run_id`, `workflow_name`, `at` (producer ISO timestamp). Step-scoped events add `step_name` — the leaf of the producer's node path, and the only piece of run structure exported (dynamic paths, static keys and resume keys deliberately stay in the producer's run log). Durations are producer-computed (`duration_ms`), so no subscriber-side state exists for them. Retry reasons are the producer's own telemetry vocabulary: `exception` | `invalid_output` | `budget_exceeded` | `provider_error` | `context_window` — the last two absorb agent-turn request failures, so there is no separate agent-error event.

> **Correlation:** aggregate by (`run_id`, `workflow_name`, `step_name`) and no finer — there is no per-execution key, so under workflow concurrency (`parallel`/`foreach`) events of same-named steps are indistinguishable beyond timestamps. Never pair started/completed events by adjacency; `duration_ms` exists precisely so no pairing is needed. `workflow_name` is unique per project by convention only; it is `""` for a crash recorded by a stale-lock reclaim (join via `run_id`).

| Event | When | Attributes beyond common |
|-------|------|--------------------------|
| `workflow.run.started` | Run begins | — |
| `workflow.run.resumed` | Run resumed | — |
| `workflow.run.blocked` | Run handed control back, waiting on a human | — |
| `workflow.run.completed` | Run finished | `duration_ms` |
| `workflow.run.failed` | Run failed terminally (incl. stale-lock reclaim) | `error.message` *(truncated to 300 chars)*, `duration_ms` |
| `workflow.run.cancelled` | Run cancelled (incl. cold cancel of a blocked run) | — |
| `workflow.step.started` | Step execution begins | — |
| `workflow.step.retried` | Step attempt failed and is retried | `attempt`, `reason`, `error.message` *(truncated)* |
| `workflow.step.completed` | Step succeeded | `duration_ms` |
| `workflow.step.failed` | `optional` step exhausted retries, run continues — the health signal for shipped workflows | `error.message` *(truncated)*, `duration_ms` |
| `workflow.step.cancelled` | Blocked step abandoned after a sibling failed | — |

> **Privacy:** payloads are content-free at the source (asserted by test in the producer): no step inputs/outputs, no questionnaire text or answers, no log text, no node paths or session keys. Error messages name schemas/fields/tools, never values, and arrive pre-truncated.

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
- Telemetry is on by default and controlled by `telemetry.enabled` in `~/.config/kimchi/config.json` (overridable via `$KIMCHI_TELEMETRY_ENABLED`).
