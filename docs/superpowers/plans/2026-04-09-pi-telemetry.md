# Pi Telemetry Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `~/.pi/agent/extensions/telemetry.ts` that sends OTLP logs (api_request per assistant message) and cumulative productivity metrics (tokens, cost, commits, PRs, LOC, edit decisions) to a configurable OTLP endpoint every 30s.

**Architecture:** Single TypeScript extension file loaded by Pi at runtime — no build step, no npm deps. Raw `fetch` for OTLP HTTP JSON payloads. State is entirely in-memory in the extension closure. Two data flows: immediate log records per assistant message, and cumulative sum metrics flushed on a 30s interval and on shutdown.

**Tech Stack:** TypeScript, `@mariozechner/pi-coding-agent` ExtensionAPI, Node.js built-in `fetch`, `node:crypto` for UUID generation.

**Key event shapes from Pi's ExtensionAPI (verified from type definitions):**
- `session_start`: no payload fields
- `session_shutdown`: no payload fields
- `message_end`: `{ message: AgentMessage }` — where `AgentMessage` may be `AssistantMessage` with `.role === "assistant"`, `.model` (string), `.provider` (string), `.usage.input`, `.usage.output`, `.usage.cacheRead`, `.usage.cacheWrite`, `.usage.cost.total`, `.timestamp` (ms)
- `tool_execution_start`: `{ toolCallId, toolName, args: any }` — args are here, NOT on end event
- `tool_execution_end`: `{ toolCallId, toolName, result: any, isError: boolean }` — no args

**Critical pattern:** Buffer tool args from `tool_execution_start` keyed by `toolCallId`, consume them in `tool_execution_end`, then delete from buffer.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `~/.pi/agent/extensions/telemetry.ts` | Full telemetry extension |

---

## Task 1: Scaffolding, config, and helpers

**Files:**
- Create: `~/.pi/agent/extensions/telemetry.ts`

- [ ] **Step 1: Create the file with imports, config type, and env-var reader**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { AssistantMessage } from "@mariozechner/pi-ai"
import { randomUUID } from "node:crypto"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TelemetryConfig {
  enabled: boolean
  logsEndpoint: string
  metricsEndpoint: string
  headers: Record<string, string>
}

function buildConfig(): TelemetryConfig {
  const enabled = !!process.env.PI_ENABLE_TELEMETRY
  const logsEndpoint = process.env.PI_OTLP_ENDPOINT ?? ""
  const metricsEndpoint = process.env.PI_OTLP_METRICS_ENDPOINT ?? ""
  const headersStr = process.env.PI_OTLP_HEADERS ?? ""

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (headersStr) {
    for (const pair of headersStr.split(",")) {
      const eq = pair.indexOf("=")
      if (eq === -1) continue
      const key = pair.slice(0, eq).trim()
      const val = pair.slice(eq + 1).trim()
      if (key) headers[key] = val
    }
  }

  return { enabled, logsEndpoint, metricsEndpoint, headers }
}
```

- [ ] **Step 2: Add helper functions**

```typescript
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowNano(): string {
  return String(Date.now() * 1_000_000)
}

function strAttr(key: string, value: string): { key: string; value: { stringValue: string } } {
  return { key, value: { stringValue: value } }
}

function inferLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript",
    js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
    py: "Python", go: "Go", rs: "Rust", rb: "Ruby",
    java: "Java", kt: "Kotlin", swift: "Swift",
    c: "C", h: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
    cs: "C#", php: "PHP", dart: "Dart",
    md: "Markdown", mdx: "Markdown",
    json: "JSON", yaml: "YAML", yml: "YAML",
    toml: "TOML", ini: "TOML",
    xml: "HTML/XML", html: "HTML/XML", htm: "HTML/XML", svg: "HTML/XML",
    css: "CSS", scss: "CSS", less: "CSS",
    sql: "SQL", sh: "Bash", bash: "Bash", zsh: "Bash",
    txt: "Plain text", proto: "Protocol Buffers",
    tf: "HCL", dockerfile: "Dockerfile",
  }
  return map[ext] ?? "unknown"
}

function countLineChanges(oldStr: string, newStr: string): { added: number; removed: number } {
  const oldLines = oldStr ? oldStr.split("\n").length : 0
  const newLines = newStr ? newStr.split("\n").length : 0
  if (newLines >= oldLines) return { added: newLines - oldLines || 1, removed: 0 }
  return { added: 0, removed: oldLines - newLines || 1 }
}
```

- [ ] **Step 3: Add OTLP log sender**

```typescript
// ---------------------------------------------------------------------------
// OTLP senders
// ---------------------------------------------------------------------------

async function sendLog(
  config: TelemetryConfig,
  eventName: string,
  attrs: Record<string, string | number>,
): Promise<void> {
  if (!config.enabled || !config.logsEndpoint) return
  const now = nowNano()
  const payload = {
    resourceLogs: [{
      resource: { attributes: [strAttr("service.name", "pi")], droppedAttributesCount: 0 },
      scopeLogs: [{
        scope: { name: "pi", version: "1.0.0" },
        logRecords: [{
          timeUnixNano: now,
          observedTimeUnixNano: now,
          severityNumber: 9,
          severityText: "INFO",
          eventName,
          body: { stringValue: eventName },
          attributes: Object.entries(attrs).map(([k, v]) => strAttr(k, String(v))),
          droppedAttributesCount: 0,
          flags: 0,
          traceId: "",
          spanId: "",
        }],
      }],
    }],
  }
  try {
    const res = await fetch(config.logsEndpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[telemetry] log send failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    console.error(`[telemetry] log send error: ${err}`)
  }
}
```

- [ ] **Step 4: Add OTLP metrics sender**

```typescript
interface MetricPayload {
  name: string
  unit?: string
  dataPoints: Array<{ value: number; attributes: Record<string, string> }>
}

async function sendMetrics(
  config: TelemetryConfig,
  metrics: MetricPayload[],
  sessionStartNano: string,
): Promise<void> {
  if (!config.enabled || !config.metricsEndpoint || metrics.length === 0) return
  const now = nowNano()
  const otlpMetrics = metrics.map((m) => ({
    name: m.name,
    description: "",
    unit: m.unit ?? "",
    sum: {
      aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
      isMonotonic: true,
      dataPoints: m.dataPoints.map((dp) => ({
        timeUnixNano: now,
        startTimeUnixNano: sessionStartNano,
        ...(Number.isInteger(dp.value)
          ? { asInt: String(dp.value) }
          : { asDouble: dp.value }),
        attributes: Object.entries(dp.attributes).map(([k, v]) => strAttr(k, v)),
      })),
    },
  }))
  const payload = {
    resourceMetrics: [{
      resource: { attributes: [strAttr("service.name", "pi")] },
      scopeMetrics: [{
        scope: { name: "pi", version: "1.0.0" },
        metrics: otlpMetrics,
      }],
    }],
  }
  try {
    const res = await fetch(config.metricsEndpoint, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      console.error(`[telemetry] metrics send failed: ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    console.error(`[telemetry] metrics send error: ${err}`)
  }
}
```

- [ ] **Step 5: Verify the file parses by checking Pi starts without errors**

```bash
pi --version
```

Expected: version string printed, no TypeScript errors.

---

## Task 2: Extension export and session lifecycle

**Files:**
- Modify: `~/.pi/agent/extensions/telemetry.ts`

- [ ] **Step 1: Add the export default function with state and session_start handler**

Append to the file:

```typescript
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const config = buildConfig()
  if (!config.enabled) return // no-op if telemetry not enabled

  // ── Mutable session state ─────────────────────────────────────────────────
  let sessionId = randomUUID()
  let sessionStartNano = nowNano()
  let sessionStartMs = Date.now()

  const sentMessages = new Set<string>()
  let cumulativeCommits = 0
  let cumulativePRs = 0
  let cumulativeLinesAdded = 0
  let cumulativeLinesRemoved = 0
  const cumulativeEditDecisions: Record<string, number> = {}
  const cumulativeTokensByModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  const cumulativeCostByModel: Record<string, number> = {}

  // Buffer tool args from tool_execution_start, keyed by toolCallId
  const pendingArgs: Map<string, { toolName: string; args: any }> = new Map()

  // ── Metric builder ────────────────────────────────────────────────────────
  function sessionAttrs(): Record<string, string> {
    return { client: "pi", "session.id": sessionId }
  }

  function buildMetrics(): MetricPayload[] {
    const sa = sessionAttrs()
    const metrics: MetricPayload[] = []

    if (cumulativeCommits > 0) {
      metrics.push({ name: "claude_code.commit.count", unit: "count", dataPoints: [{ value: cumulativeCommits, attributes: { ...sa } }] })
    }
    if (cumulativePRs > 0) {
      metrics.push({ name: "claude_code.pull_request.count", unit: "count", dataPoints: [{ value: cumulativePRs, attributes: { ...sa } }] })
    }
    if (cumulativeLinesAdded > 0) {
      metrics.push({ name: "claude_code.lines_of_code.count", unit: "count", dataPoints: [{ value: cumulativeLinesAdded, attributes: { ...sa, type: "added" } }] })
    }
    if (cumulativeLinesRemoved > 0) {
      metrics.push({ name: "claude_code.lines_of_code.count", unit: "count", dataPoints: [{ value: cumulativeLinesRemoved, attributes: { ...sa, type: "removed" } }] })
    }
    for (const [key, count] of Object.entries(cumulativeEditDecisions)) {
      if (count <= 0) continue
      const [toolName, language] = key.split("|")
      metrics.push({
        name: "claude_code.code_edit_tool.decision", unit: "count",
        dataPoints: [{ value: count, attributes: { ...sa, tool_name: toolName, language: language ?? "unknown", decision: "accept", source: "auto" } }],
      })
    }
    for (const [model, tokens] of Object.entries(cumulativeTokensByModel)) {
      for (const [type, value] of [["input", tokens.input], ["output", tokens.output], ["cacheRead", tokens.cacheRead], ["cacheCreation", tokens.cacheWrite]] as [string, number][]) {
        if (value > 0) {
          metrics.push({ name: "claude_code.token.usage", unit: "count", dataPoints: [{ value, attributes: { ...sa, type, model } }] })
        }
      }
    }
    for (const [model, cost] of Object.entries(cumulativeCostByModel)) {
      if (cost > 0) {
        metrics.push({ name: "claude_code.cost.usage", unit: "USD", dataPoints: [{ value: cost, attributes: { ...sa, model } }] })
      }
    }
    return metrics
  }

  // ── Flush ─────────────────────────────────────────────────────────────────
  async function flush(): Promise<void> {
    const metrics = buildMetrics()
    await sendMetrics(config, metrics, sessionStartNano)
  }

  // ── 30s interval ─────────────────────────────────────────────────────────
  let flushTimer: ReturnType<typeof setInterval> | null = null

  function ensureFlushTimer(): void {
    if (flushTimer) return
    flushTimer = setInterval(() => { void flush() }, 30_000)
  }

  // ── Reset on session_start ────────────────────────────────────────────────
  pi.on("session_start", async () => {
    sessionId = randomUUID()
    sessionStartNano = nowNano()
    sessionStartMs = Date.now()
    sentMessages.clear()
    cumulativeCommits = 0
    cumulativePRs = 0
    cumulativeLinesAdded = 0
    cumulativeLinesRemoved = 0
    for (const k of Object.keys(cumulativeEditDecisions)) delete cumulativeEditDecisions[k]
    for (const k of Object.keys(cumulativeTokensByModel)) delete cumulativeTokensByModel[k]
    for (const k of Object.keys(cumulativeCostByModel)) delete cumulativeCostByModel[k]
    pendingArgs.clear()
  })
```

- [ ] **Step 2: Add session_shutdown handler and SIGINT guard**

```typescript
  // ── Shutdown: flush + clear timer ─────────────────────────────────────────
  async function onShutdown(): Promise<void> {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null }
    await flush()
  }

  pi.on("session_shutdown", async () => { await onShutdown() })

  // Guard against force-quit losing up to 30s of metrics
  process.once("SIGINT", () => {
    void onShutdown().finally(() => process.kill(process.pid, "SIGINT"))
  })
```

- [ ] **Step 3: Verify Pi still starts cleanly**

```bash
pi --version
```

Expected: version string, no errors.

---

## Task 3: Assistant message tracking (api_request log + token/cost accumulation)

**Files:**
- Modify: `~/.pi/agent/extensions/telemetry.ts`

- [ ] **Step 1: Add message_end handler inside the export default function**

```typescript
  // ── Assistant message → api_request log + token/cost accumulation ─────────
  pi.on("message_end", async (event) => {
    const msg = event.message
    if (msg.role !== "assistant") return

    const assistant = msg as AssistantMessage
    const msgId = String(assistant.timestamp) // unique enough per session
    if (sentMessages.has(msgId)) return
    sentMessages.add(msgId)

    const model = assistant.model ?? "unknown"
    const provider = String(assistant.provider ?? "unknown")
    const { input, output, cacheRead, cacheWrite } = assistant.usage
    const costTotal = assistant.usage.cost.total
    const durationMs = Date.now() - sessionStartMs // approx turn duration

    // Send log record
    await sendLog(config, "api_request", {
      "event.name": "api_request",
      client: "pi",
      "session.id": sessionId,
      model,
      provider,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      cost_usd: costTotal,
      duration_ms: durationMs,
    })

    // Accumulate tokens
    if (!cumulativeTokensByModel[model]) {
      cumulativeTokensByModel[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    cumulativeTokensByModel[model].input += input
    cumulativeTokensByModel[model].output += output
    cumulativeTokensByModel[model].cacheRead += cacheRead
    cumulativeTokensByModel[model].cacheWrite += cacheWrite

    // Accumulate cost
    if (costTotal > 0) {
      cumulativeCostByModel[model] = (cumulativeCostByModel[model] ?? 0) + costTotal
    }

    ensureFlushTimer()
  })
```

- [ ] **Step 2: Verify Pi starts and runs without errors**

```bash
pi --version
```

Expected: no errors.

- [ ] **Step 3: Smoke-test: start Pi with telemetry env vars set to a local netcat listener**

In one terminal:
```bash
nc -lk 4318
```

In another:
```bash
PI_ENABLE_TELEMETRY=1 PI_OTLP_ENDPOINT=http://localhost:4318 pi
```

Ask pi to list files. After pi responds, check the netcat terminal — you should see a raw HTTP POST with `api_request` in the JSON body.

---

## Task 4: Tool arg buffering + bash commit/PR tracking

**Files:**
- Modify: `~/.pi/agent/extensions/telemetry.ts`

- [ ] **Step 1: Add tool_execution_start handler to buffer args**

```typescript
  // ── Buffer args from tool_execution_start ─────────────────────────────────
  pi.on("tool_execution_start", async (event) => {
    pendingArgs.set(event.toolCallId, { toolName: event.toolName, args: event.args })
  })
```

- [ ] **Step 2: Add tool_execution_end handler with bash commit/PR detection**

```typescript
  // ── Tool execution end: consume buffered args ─────────────────────────────
  pi.on("tool_execution_end", async (event) => {
    const pending = pendingArgs.get(event.toolCallId)
    pendingArgs.delete(event.toolCallId)
    if (!pending) return

    const { toolName, args } = pending

    // ── bash: detect commits and PRs ────────────────────────────────────────
    if (toolName === "bash") {
      const command = String(args?.command ?? "")
      if (/git\s+commit\b/.test(command) && !/--dry-run/.test(command)) {
        cumulativeCommits += 1
        ensureFlushTimer()
      }
      if (/gh\s+pr\s+create\b/.test(command)) {
        cumulativePRs += 1
        ensureFlushTimer()
      }
    }
  })
```

- [ ] **Step 3: Verify Pi starts cleanly**

```bash
pi --version
```

---

## Task 5: Edit/Write/MultiEdit LOC and edit decision tracking

**Files:**
- Modify: `~/.pi/agent/extensions/telemetry.ts`

- [ ] **Step 1: Extend the tool_execution_end handler to cover edit, write, multiedit**

Replace the bash-only `tool_execution_end` handler body (the part after the bash block) with:

```typescript
    // ── edit: LOC diff + edit decision ──────────────────────────────────────
    if (toolName === "edit") {
      const filePath = String(args?.filePath ?? "")
      const language = inferLanguage(filePath)
      const changes = countLineChanges(String(args?.oldString ?? ""), String(args?.newString ?? ""))
      cumulativeLinesAdded += changes.added
      cumulativeLinesRemoved += changes.removed
      const key = `Edit|${language}`
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] ?? 0) + 1
      ensureFlushTimer()
    }

    // ── write: all lines as added ────────────────────────────────────────────
    if (toolName === "write") {
      const filePath = String(args?.filePath ?? "")
      const language = inferLanguage(filePath)
      const content = String(args?.content ?? "")
      cumulativeLinesAdded += content ? content.split("\n").length : 1
      const key = `Write|${language}`
      cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] ?? 0) + 1
      ensureFlushTimer()
    }

    // ── multiedit: treat each edit pair as an Edit ───────────────────────────
    if (toolName === "multiedit") {
      const filePath = String(args?.filePath ?? "")
      const language = inferLanguage(filePath)
      const edits: Array<{ oldString?: string; newString?: string }> = Array.isArray(args?.edits) ? args.edits : []
      for (const edit of edits) {
        const changes = countLineChanges(String(edit.oldString ?? ""), String(edit.newString ?? ""))
        cumulativeLinesAdded += changes.added
        cumulativeLinesRemoved += changes.removed
        const key = `Edit|${language}`
        cumulativeEditDecisions[key] = (cumulativeEditDecisions[key] ?? 0) + 1
      }
      if (edits.length > 0) ensureFlushTimer()
    }
  }) // end tool_execution_end handler
} // end export default function
```

- [ ] **Step 2: Verify Pi starts cleanly**

```bash
pi --version
```

- [ ] **Step 3: Smoke-test edit tracking**

With `PI_ENABLE_TELEMETRY=1 PI_OTLP_METRICS_ENDPOINT=http://localhost:4318 pi`, ask pi to edit a TypeScript file. After 30s (or on exit), check the netcat listener for a `claude_code.lines_of_code.count` metric and a `claude_code.code_edit_tool.decision` metric with `tool_name=Edit language=TypeScript`.

- [ ] **Step 4: Commit**

```bash
cd ~/.pi
git add agent/extensions/telemetry.ts
git commit -m "feat: add pi telemetry extension with OTLP logs and metrics"
```

---

## Task 6: Verify full integration against real endpoint

**Files:** none

- [ ] **Step 1: Export env vars pointing at your real OTLP endpoint**

```bash
export PI_ENABLE_TELEMETRY=1
export PI_OTLP_ENDPOINT=<your-logs-endpoint>
export PI_OTLP_METRICS_ENDPOINT=<your-metrics-endpoint>
export PI_OTLP_HEADERS="Authorization=Bearer <your-token>"
```

- [ ] **Step 2: Start Pi and do a multi-step task (read a file, edit it, commit)**

```bash
pi
```

- [ ] **Step 3: Check Grafana for incoming data**

In Grafana, query:
- `claude_code.token.usage{client="pi"}` — should show token counts
- `claude_code.cost.usage{client="pi"}` — should show cost
- `claude_code.commit.count{client="pi"}` — should show 1 after a commit
- `claude_code.code_edit_tool.decision{client="pi"}` — should show edit decisions

Also check the logs explorer for `api_request` log records with `service.name=pi`.

---

## Self-Review

**Spec coverage:**
- ✓ `PI_ENABLE_TELEMETRY`, `PI_OTLP_ENDPOINT`, `PI_OTLP_METRICS_ENDPOINT`, `PI_OTLP_HEADERS` (Task 1)
- ✓ `service.name=pi` (Tasks 1, 3)
- ✓ `session_start` resets state + generates UUID session.id (Task 2)
- ✓ `session_shutdown` + SIGINT flush (Task 2)
- ✓ `api_request` log per assistant message with dedup (Task 3)
- ✓ Token + cost accumulation by model (Task 3)
- ✓ 30s metric flush interval, starts lazily on first event (Tasks 2, 3)
- ✓ Tool arg buffering via `tool_execution_start` (Task 4)
- ✓ Bash commit/PR detection via regex (Task 4)
- ✓ Edit/write/multiedit LOC + edit decision tracking (Task 5)
- ✓ All 6 metric names preserved exactly from opencode (Task 2)
- ✓ `session.id` on all metrics (Task 2)
- ✓ Header parsing: full `key=value,key=value` OTLP format (Task 1)
- ✓ Errors logged to console, no crash (Tasks 1, 3)

**Placeholder scan:** None. All code blocks are complete and self-contained.

**Type consistency:**
- `TelemetryConfig` defined Task 1, used throughout
- `MetricPayload` defined Task 1, used in `buildMetrics()` and `sendMetrics()`
- `sessionAttrs()` defined Task 2, used in `buildMetrics()` — consistent
- `pendingArgs` map defined Task 2, written in Task 4 Step 1, read in Task 4 Step 2 — consistent
- `cumulativeEditDecisions` key format `Tool|Language` defined Task 2, written in Task 5, read in `buildMetrics()` — consistent
- `ensureFlushTimer()` defined Task 2, called in Tasks 3, 4, 5 — consistent
