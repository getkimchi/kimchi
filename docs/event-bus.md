# Event Bus Channels

Extensions communicate through the pi event bus (`pi.events`), available to every extension including externally loaded ones (`-e`). All channels use `pi.events.emit(channel, payload)` to publish and `pi.events.on(channel, handler)` to subscribe.

---

## 1. Subagent Events

**Source:** `src/extensions/agents/index.ts`

| Channel | Payload | When |
|---|---|---|
| `subagents:ready` | `{}` | Agent extension finished loading |
| `subagents:started` | `{ id, ... }` | A subagent run begins |
| `subagents:completed` | `{ id, ... }` | A subagent finishes successfully |
| `subagents:failed` | `{ id, error, ... }` | A subagent fails |
| `subagents:created` | `{ id, ... }` | A new subagent record is persisted |
| `subagents:backgrounded` | `{ id, ... }` | A subagent is backgrounded |
| `subagents:compacted` | `{ id, ... }` | A subagent's context is compacted |
| `subagents:steered` | `{ id, message }` | A steering message is sent to a subagent |

**Consumers:** `activity.ts` (activity tracking), `hook-adapters/adapter.ts` (Claude Code hooks), `telemetry/index.ts`

---

## 2. Plan Review Events

**Source:** `src/shared/planning/plan-review-bus.ts`

Two channels coordinate plan reviews across surfaces (TUI popup, plannotator browser, future integrators). Only one plan review is active at a time — adhoc plan mode and ferment scoping are mutually exclusive.

### `kimchi:plan-review-request`

Emitted when a plan is ready for user review. Emitters **always** emit, even in headless/oneshot sessions; subscribers self-select whether to act.

**Payload:**

```ts
interface PlanReviewRequestPayload {
  planContent: string           // full plan markdown
  planFilePath?: string        // saved path on disk
  source: "adhoc" | "ferment"  // which planning flow produced the plan
  fermentId?: string           // present when source === "ferment"
}
```

**Producers:**

| Producer | `source` | When |
|---|---|---|
| `submit_plan` tool (adhoc plan mode) | `"adhoc"` | Model calls `submit_plan` with the completed plan |
| `propose_ferment_scoping` tool (ferment) | `"ferment"` | Model calls `propose_ferment_scoping` with the scoping payload (terminate: true) |
| `agent_end` handler (ferment) | `"ferment"` | Pending review exists at turn end without an in-turn emit (e.g. restored state) |
| `setPendingPlanReviewTrigger` (resume) | `"ferment"` | Draft ferment resumed with a persisted pending proposal |

**Consumers:**
- **TUI popup** — permissions extension shows `ctx.ui.select` (adhoc) or `promptPlanReview` (ferment)
- **Plannotator adapter** — fires `plannotator:request` to open the browser UI; skips non-interactive sessions (`!ctx.hasUI || ferment-oneshot`)
- **Future integrators** — logging, CI reviewers, alternative UIs can subscribe independently

### `kimchi:plan-review-decision`

Emitted when any surface reaches a decision. **First decision wins** — subsequent emissions are silently ignored. The decision is only emitted if a matching review is active (same `planReviewSource`).

**Payload:**

```ts
interface PlanReviewDecisionPayload {
  decision: "execute" | "start_ferment" | "rework" | "feedback"
  feedback?: string             // present for "feedback" decisions
  source: "kimchi-tui" | "plannotator"  // which surface decided
  planReviewSource: "adhoc" | "ferment"  // which review this decision belongs to
  fermentId?: string           // present for ferment reviews
  auto?: boolean                // ferment: user picked auto mode (run all stages without stopping)
}
```

**Producers:**

| Producer | `source` | `decision` values |
|---|---|---|
| TUI `ctx.ui.select` (adhoc) | `"kimchi-tui"` | `"execute"`, `"start_ferment"`, `"rework"` |
| TUI `promptPlanReview` (ferment) | `"kimchi-tui"` | `"execute"` (with `auto: true` for start_auto), `"rework"`, `"feedback"` |
| Plannotator browser approve/deny | `"plannotator"` | `"execute"`, `"rework"` (no feedback), `"feedback"` (with feedback text) |

**Consumers:**
- **Permissions decision handler** (adhoc) — consumes context, changes mode, executes plan or creates ferment
- **Ferment decision handler** (ferment) — consumes context, confirms scope, schedules wake-up, or triggers revision turn

### Context storage

When a request is emitted, a `PlanReviewContext` (containing `ctx`, `planPath`, `planText`, `activePlanSlug`, `fermentId`) is stored module-level. The decision handler consumes it via `consumePlanReviewContext()`. Context is cleared after consumption — a stale TUI menu pick arriving after plannotator already decided finds no context and is silently dropped.

---

## 3. Ferment Domain Events

**Source:** `src/extensions/ferment/domain-events.ts`

Typed payloads defined in the source file.

| Channel | Payload type | When |
|---|---|---|
| `ferment:started` | `FermentStartedPayload` | New ferment created |
| `ferment:completed` | `FermentCompletedPayload` | Ferment finished with grade |
| `ferment:abandoned` | `FermentAbandonedPayload` | Ferment abandoned |
| `ferment:suspended` | `FermentSuspendedPayload` | Ferment paused |
| `ferment:resumed` | `FermentResumedPayload` | Ferment resumed |
| `ferment:stalled` | `FermentStalledPayload` | Ferment detected as idle/stalled |
| `ferment:phase_started` | `FermentPhaseStartedPayload` | A phase activates |
| `ferment:phase_completed` | `FermentPhaseCompletedPayload` | A phase completes (with grade, duration, token deltas) |
| `ferment:step_started` | `FermentStepStartedPayload` | A step begins |
| `ferment:step_completed` | `FermentStepCompletedPayload` | A step finishes |
| `ferment:step_failed` | `FermentStepFailedPayload` | A step fails |
| `ferment:steering` | `FermentSteeringPayload` | Ferment receives a steering message |
| `ferment:scoping_resumed` | `FermentScopingResumedPayload` | Scoping resumes after restart |
| `ferment:scoping_complete` | `FermentScopingCompletedPayload` | Scoping confirmed |
| `ferment:user_unblocked` | `UserUnblockedPayload` | User responds to an ask-user prompt (with duration) |

**Consumers:** `telemetry/index.ts` (all channels), `ferment/ask-user.ts` emits `user_unblocked`

---

## 4. Bash Tool Guard Events

**Source:** `src/extensions/bash-tool-guard-events.ts`

| Channel | Payload type | When |
|---|---|---|
| `bash_tool_guard:warn` | `BashToolGuardWarnPayload` | A bash command matches a guarded pattern (cat, sed, etc.) |
| `bash_tool_guard:block` | `BashToolGuardBlockPayload` | A guarded bash command is blocked |
| `bash_tool_guard:allowed_by_user_request` | `BashToolGuardAllowedByUserRequestPayload` | User explicitly allowed a guarded command |

Payloads carry category, tool, count — no raw command text (privacy).

**Consumers:** `telemetry/index.ts`

---

## 5. Loop Guard Events

**Source:** `src/extensions/loop-guard-events.ts`

| Channel | Payload type | When |
|---|---|---|
| `loop_guard:warn` | `LoopGuardWarnPayload` | Repetition detector fires (consecutive identical, n-gram, edit run, bash repetition) |
| `loop_guard:subagent_abort` | `LoopGuardSubagentAbortPayload` | A subagent is aborted due to loop guard |

Payloads carry detector, count, is_subagent — no raw tool args.

**Consumers:** `telemetry/index.ts`

---

## 6. Workflow Telemetry

**Source:** `src/extensions/telemetry/workflow-events.ts`

Single envelope channel discriminated by `payload.event`:

| Channel | Payload discriminator | Events |
|---|---|---|
| `workflow:telemetry` | `WorkflowEventPayload` | `run_started`, `run_resumed`, `run_blocked`, `run_completed`, `run_failed`, `run_cancelled`, `step_started`, `step_retried`, `step_completed`, `step_failed`, `step_cancelled` |

Emitted by `@kimchi-dev/kimchi-workflows` (external package). This file is a mirror of the canonical contract — it should be deleted once a shared contract package exists.

**Consumers:** `telemetry/index.ts`

---

## 7. Notification Channel

**Source:** Generic (emitted by multiple extensions)

| Channel | Payload | When |
|---|---|---|
| `notification` | `{ notification_type: "permission_prompt", tool_name, tool_use_id }` | Permissions extension shows an approval dialog |
| `notification` | `{ notification_type: "agent_needs_input" }` | Questionnaire tool prompts the user |
