# Pi Telemetry Extension Design

**Goal:** Port the opencode-kimchi OTLP telemetry pattern to a Pi extension at `~/.pi/agent/extensions/telemetry.ts`, tracking every signal the opencode PR tracks: API request logs per assistant message, and cumulative productivity metrics (tokens, cost, commits, PRs, LOC, edit decisions) flushed every 30s.

---

## Architecture

Single TypeScript file loaded by Pi at runtime. No build step, no npm dependencies. Uses Node.js built-in `fetch` for OTLP HTTP JSON payloads — same raw-fetch pattern as the opencode implementation, no OTel SDK.

State is entirely in-memory, scoped to the extension function closure. Metrics accumulate cumulatively from session start; the 30s flush sends the running total as `AGGREGATION_TEMPORALITY_CUMULATIVE` sums.

**Env vars (PI_* prefix, mirrors opencode's OPENCODE_* vars):**
- `PI_ENABLE_TELEMETRY` — any truthy value enables telemetry
- `PI_OTLP_ENDPOINT` — logs ingest URL (per api_request event)
- `PI_OTLP_METRICS_ENDPOINT` — metrics ingest URL (30s flush)
- `PI_OTLP_HEADERS` — comma-separated `key=value` pairs, e.g. `Authorization=Bearer <token>,x-custom=foo`

**service.name:** `"pi"` (not `"opencode"`)

---

## Event Mapping

Pi's ExtensionAPI events map to opencode events as follows:

| opencode event | Pi event | Action |
|---|---|---|
| `session.created` | `session_start` | Reset all cumulative state, record `sessionStartNano`, generate `sessionId` UUID |
| `session.idle` | `session_shutdown` + `process.on('SIGINT')` | Final metric flush before process exits |
| `message.updated` (assistant, finished) | `message_end` | Send `api_request` log, accumulate tokens/cost |
| `tool.execute.after` (bash, commit regex) | `tool_execution_end` (bash) | Increment commit/PR count |
| `tool.execute.after` (edit) | `tool_execution_end` (edit) | Accumulate LOC, record edit decision |
| `tool.execute.after` (write) | `tool_execution_end` (write) | Accumulate LOC added, record write decision |
| file.edited event | Not available in Pi | LOC tracking done solely via tool_execution_end |

**Note:** Pi's `tool_execution_end` event provides `toolName` and the tool args/result. The extension reads `event.args` for edit/write/bash tool tracking. If the args shape is unavailable, LOC tracking falls back to incrementing by 1 per call.

---

## Data Flows

### Logs (api_request)

One OTLP log record per completed assistant message, sent immediately to `PI_OTLP_ENDPOINT`.

Fields:
- `event.name`: `"api_request"`
- `client`: `"pi"`
- `model`: model ID string
- `provider`: provider ID string
- `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`
- `cost_usd`: total cost for the message
- `duration_ms`: `time.completed - time.created`

Dedup: messages tracked by ID in a `Set<string>`; duplicate `message_end` events for the same message ID are skipped.

### Metrics (30s flush)

Cumulative sums sent to `PI_OTLP_METRICS_ENDPOINT` every 30s via `setInterval`, and once more on `session_shutdown`.

Metric names (preserved exactly from opencode for Grafana dashboard compatibility):

| Metric | Attributes |
|---|---|
| `claude_code.token.usage` | `type` (input/output/cacheRead/cacheCreation), `model`, `client=pi`, `session.id` |
| `claude_code.cost.usage` | `model`, `client=pi`, `session.id` |
| `claude_code.commit.count` | `client=pi`, `session.id` |
| `claude_code.pull_request.count` | `client=pi`, `session.id` |
| `claude_code.lines_of_code.count` | `type` (added/removed), `client=pi`, `session.id` |
| `claude_code.code_edit_tool.decision` | `tool_name`, `language`, `decision=accept`, `source=auto`, `client=pi`, `session.id` |

Flush is skipped if there are no non-zero metrics (nothing to send).

---

## Tool Tracking Logic

**Bash (commit detection):**
```
/git\s+commit\b/.test(command) && !/--dry-run/.test(command)
```
→ `cumulativeCommits += 1`

**Bash (PR detection):**
```
/gh\s+pr\s+create\b/.test(command)
```
→ `cumulativePRs += 1`

**Edit tool:**
- Language inferred from file extension
- LOC: `countLineChanges(oldString, newString)` — compares line counts
- Edit decision key: `Edit|<language>`

**Write tool:**
- LOC added: `content.split("\n").length`
- Edit decision key: `Write|<language>`

**MultiEdit tool** (Pi-specific, not in opencode):
- Track as `Edit` for each `{oldString, newString}` pair in `edits` array
- Language inferred from `filePath`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `~/.pi/agent/extensions/telemetry.ts` | Full telemetry extension |

---

## Error Handling

- All `fetch` calls wrapped in try/catch; errors logged to console (no crash)
- If `PI_OTLP_ENDPOINT` or `PI_OTLP_METRICS_ENDPOINT` is empty, that flow is silently skipped
- `setInterval` handle stored; cleared on `session_shutdown` to avoid leaking timers
- `process.once('SIGINT', ...)` registered to flush metrics on force-quit, then re-raises the signal

---

## Not Included

- No toast/UI error notifications (Pi's `ctx.ui.notify` requires `ctx.hasUI` guard; telemetry errors go to console only)
- No OAuth token refresh
