# Implement a state-aware Ferment lifecycle obligation guard

## Objective

Prevent a Ferment from silently stalling when the model ends an assistant turn with no tool calls while persisted Ferment state still requires a concrete lifecycle transition.

The guard must be model-agnostic. It must derive the outstanding obligation from the Ferment state machine, not from model identity or phrases such as "calling `scope_ferment` now."

## User-visible failure being fixed

In automated/one-shot scoping, the model can produce this sequence:

1. It returns scoping prose with `toolCalls: []` and `stopReason: "stop"`.
2. Kimchi sends its existing reactive continuation nudge (budget: 1).
3. The model replies "Calling `scope_ferment` now," but again returns `toolCalls: []` and `stopReason: "stop"`.
4. The reactive retry cap of one is exhausted.
5. No plan is persisted, implementation tools never unlock, and the one-shot task exits without a coding attempt.

After this change, the same sequence must receive a second bounded retry. If the model emits a valid lifecycle tool call, the Ferment must advance normally. If it still refuses to call a required tool, Kimchi must surface an explicit stalled diagnostic instead of silently disappearing.

## Scope: automated mode first

The reported bug is a one-shot/automated failure — the task "fails immediately without any coding attempt." In interactive mode a stall does not "fail"; the user is present to steer.

**The guard ships automated-only.** It fires only when `runtime.isAutomatedContinuationEnabled()` is true. This eliminates the risk of interrupting legitimate model-to-user conversation during interactive scoping (e.g. text-only stops that explain trade-offs without ending in a question mark).

Interactive mode is a follow-up that requires proving the `maybeRunUserInputDropdown` detection is sufficient to distinguish legitimate conversation stops from lifecycle stalls. That validation is deferred.

## Important current-state facts

- `src/extensions/ferment/scheduler.ts` currently suppresses a `scope` nudge only when the continuation policy is not `automated`.
- Automated/one-shot scope recovery therefore already works for one retry via `maybeInjectReactiveContinuationNudge`.
- The immediate defect is `MAX_CONSECUTIVE_REACTIVE_NUDGES = 1` in `src/extensions/ferment/nudge.ts` plus retry state being keyed only by Ferment ID.
- The existing TUI regression test (`tests/e2e/tui/ferment-oneshot-scope-nudge.test.ts`) proves that a first empty stop creates a second model request, but its second scripted response also contains no tool call. It does not prove that scoping completes.
- The pinned `@earendil-works/pi-coding-agent` SDK exposes `turn_end` and `sendMessage(..., { deliverAs: "steer" })`. It does not expose a stop-veto result or a provider-independent API for forcing a named tool call.

## Non-goals

- Do not inspect or parse reasoning text to infer intended tool calls.
- Do not synthesize a `scope_ferment` payload. The model must still produce the plan and gate evidence.
- Do not add provider-specific `tool_choice` behavior.
- Do not modify files under `patches/`.
- Do not modify `src/core/export-html/` templates.
- Do not change Ferment FSM transition validation.
- Do not apply state transitions directly (no force-injection). The guard schedules another model turn; it never applies the transition itself.
- Do not turn recovery actions with several legal choices into an automatically executed transition.
- Do not remove the existing scoping exploration or tool-using-stop nudges; they cover different failure shapes.
- Do not fire the guard in interactive mode in this iteration.

## Domain model

The implementation must preserve this separation:

```text
persisted Ferment state
        ↓
determineNextAction / continuation policy
        ↓
declarative lifecycle obligation
        ↓
model emits corresponding lifecycle tool call
        ↓
tool validates and persists the transition
```

The guard belongs between action derivation and the model's next opportunity to call the tool. It schedules another model turn; it never applies the state transition itself.

## Required behavior

### Qualification

A turn qualifies for lifecycle-stop recovery only when all of these are true:

1. The message role is `assistant`.
2. The turn was not aborted or errored (handled by existing early returns).
3. The normalized assistant content contains zero `toolCall` parts.
4. `runtime.isAutomatedContinuationEnabled()` is true.
5. An active Ferment exists and fresh persisted state is neither `complete`, `abandoned`, nor `paused`.
6. No pending plan review is deliberately suppressing tools.
7. The turn was not handled as a legitimate user-input question or manual boundary.
8. Ferment state and continuation policy expose a concrete lifecycle obligation.

The guard must not fire for:

- `stopReason: "aborted"`;
- `stopReason: "error"` — transport/provider failures use a separate error-recovery path and clear the lifecycle-stop retry budget before recovery;
- tool-using turns;
- pending plan review;
- paused or terminal Ferments;
- an idle state with no lifecycle action;
- a manual phase boundary waiting for user confirmation;
- subagent worker processes;
- interactive mode (continuation policy is not `automated`).

### Error vs stop separation

The current `stopReason === "error"` path in `events.ts` calls `maybeInjectReactiveContinuationNudge`. This conflates transport failures with model-chosen bare stops. After this change:

- `stopReason === "error"` must use a separate error-recovery path (a direct call to the scheduler or an explicitly named error-recovery helper).
- `stopReason === "error"` must clear the lifecycle-stop retry budget. This deliberately gives the unchanged obligation a fresh budget after transport recovers.
- The old `maybeInjectReactiveContinuationNudge` is replaced by the guard for the bare-stop case; error recovery retains its own independent scheduling call.

### Retry budget

Allow **two retries after the original invalid stop**, meaning the model receives at most three total opportunities for one unchanged obligation:

```text
original response: empty tool calls
retry 1:           scheduled by guard
retry 2:           scheduled by guard
then:              explicit exhaustion diagnostic
```

```ts
const MAX_LIFECYCLE_STOP_RETRIES = 2
```

### Obligation identity

Key retry state by the concrete outstanding action, not only by Ferment ID:

```text
fermentId + action.kind + phaseId? + stepId?
```

Examples:

```text
ferment-123:scope
ferment-123:activate_phase:phase-1
ferment-123:start_step:phase-1:step-2
```

Properties required from this design:

- Calling an unrelated `read`, `grep`, or `ls` tool does not reset an unchanged `scope` obligation. (The current reactive nudge resets on any tool call via `onFermentToolCallSeen` — this is a bug the guard fixes.)
- When `scope_ferment` succeeds, state advances and the new `activate_phase` obligation receives a fresh budget automatically because its key differs.
- Switching to another phase or step produces a new key.
- Pausing, completing, abandoning, aborting, or ending the session clears relevant in-memory retry state.
- A new current key replaces the previous per-Ferment retry state so the map does not grow for the life of a long Ferment.

Track whether exhaustion has already been reported for a key. Repeated event processing must not emit the same visible exhaustion breadcrumb on every turn.

### Action classification

Use the existing state engine and continuation policy rather than reimplementing lifecycle ordering.

Concrete obligations eligible for a tool-specific retry:

| Declarative action | Tool/instruction |
|---|---|
| `scope` in automated mode | `scope_ferment` |
| `activate_phase` | `activate_ferment_phase` |
| `refine` | `refine_ferment_phase` |
| `start_step` | `start_ferment_step` |
| `complete_step` | `complete_ferment_step` (retain existing warning: valid only after linked worker completion/report) |
| `verify_step` | `verify_ferment_step` |
| `complete_phase` | `complete_ferment_phase` |
| `complete_ferment` | `complete_ferment` |

Actions that are not a single forced tool obligation:

| Declarative action | Behavior |
|---|---|
| `recover_step` | Keep contextual recovery guidance; do not choose retry vs. skip automatically |
| `recover_phase` | Keep contextual recovery guidance; do not choose retry vs. skip vs. abandon automatically |
| `pause` | Do not nudge |
| no action | Do not nudge |

If preserving existing behavior requires `recover_step`/`recover_phase` to receive a retry prompt, the prompt must remain choice-oriented and must not claim one exact tool is mandatory. Document that exception in code and cover it with a test.

### Exhaustion

When the unchanged obligation has consumed both retries:

1. Do not schedule another model turn.
2. Emit one visible `ferment_breadcrumb` explaining:
   - the Ferment name;
   - the required action/tool;
   - that two lifecycle-stop retries were exhausted;
   - that no state transition was applied automatically.
3. Emit the existing `FERMENT_EVENTS.STALLED` telemetry event if its payload can accurately represent this failure without changing its meaning. If not, extend the event payload or add a specific event in the smallest compatible way and test it.
4. Leave persisted state intact. Do not silently mark the action complete, skip work, or fabricate a plan.
5. Preserve current one-shot shutdown semantics unless product requirements explicitly change them. The important improvement is that exhaustion is observable before shutdown.

## Proposed code structure

### 1. Add a pure guard module

Create:

```text
src/extensions/ferment/lifecycle-obligation-guard.ts
src/extensions/ferment/lifecycle-obligation-guard.test.ts
```

Keep decision logic independent of `ExtensionAPI` where practical. Suggested public concepts:

```ts
type LifecycleObligation = {
  key: string
  action: DeclarativeAction
  toolName?: string
}

type LifecycleGuardDecision =
  | { type: "none" }
  | { type: "retry"; obligation: LifecycleObligation; attempt: number; maxAttempts: number }
  | { type: "exhausted"; obligation: LifecycleObligation; report: boolean }
```

The exact API may differ, but preserve these responsibilities:

- derive or accept the current action;
- classify whether it is a concrete obligation;
- build a stable obligation key;
- count retries per obligation;
- report exhaustion only once;
- clear/prune counters by Ferment;
- remain unit-testable without a live pi session.

Do not place this counter in the persisted Ferment event store. It is an agent-loop recovery budget, not domain progress. Session-memory storage matches the existing nudge counters and avoids replay changing domain state.

A pi-dependent `maybeInjectLifecycleObligationGuard(pi, runtime, callbacks?)` wrapper schedules the retry via `scheduleNextFermentAction` or emits the exhaustion breadcrumb + `FERMENT_EVENTS.STALLED` telemetry.

### 2. Integrate into `turn_end`

Relevant file:

```text
src/extensions/ferment/events.ts
```

Preserve the early handling for workers, aborts, and errors.

Recommended logical order:

```text
assistant role guard
→ abort handling
→ provider/error handling (separate from lifecycle-stop budget)
→ refresh active Ferment
→ existing tool-using scoping progress/stop handling
→ existing user-input/manual-boundary dropdown handling
→ NEW zero-tool lifecycle guard (automated only)
→ existing tool-using Ferment stop nudge
→ compaction/profile handling
```

For the new branch:

```ts
if (!toolCallSeen) {
  const outcome = maybeInjectLifecycleObligationGuard(pi, runtime, callbacks)
  if (outcome) return
}
```

Returning after a scheduled retry prevents the generic scoping nudge paths from sending a second message for the same turn.

Replace `maybeInjectReactiveContinuationNudge` for the bare-stop case with the guard. The `stopReason === "error"` path in one-shot mode must retain its own independent scheduling call (not the guard, not the old reactive nudge).

### 3. Handle final completion without duplicate nudges

The normal `decideContinuation()` path treats `complete_ferment` as idle unless `treatCompleteFermentAsContinue` is set. `agent_end` also contains a special final-completion follow-up.

The new guard must either:

- derive final completion with `treatCompleteFermentAsContinue: true` and set the existing `onFinalCompletionNudgeScheduled` callback/latch so `agent_end` does not schedule a duplicate; or
- explicitly leave `complete_ferment` to the existing `agent_end` mechanism and document/test why it is outside the guard.

Preferred: include `complete_ferment` in the guard and reuse the existing duplicate-suppression latch.

### 4. Update reset/cleanup paths

Replace calls to the old reactive counter reset APIs as necessary.

All references to update:

```text
src/extensions/ferment/events.ts          — resetReactiveContinuationNudgeCount (3 sites: abort, error, toolCallSeen)
src/extensions/ferment/tools/lifecycle.ts — resetReactiveContinuationNudgeCount (3 sites: scope_ferment, propose_ferment_scoping, update_ferment_scope_field)
src/extensions/ferment/commands.ts        — resetReactiveContinuationNudgeCount (1 site: /ferment resume)
src/extensions/ferment/index.test.ts      — resetAllReactiveContinuationNudgeCounts
src/extensions/ferment/nudge.test.ts       — all tests using maybeInjectReactiveContinuationNudge
src/extensions/ferment/commands.test.ts   — 3 tests using maybeInjectReactiveContinuationNudge
```

The guard's reset API must cover: abort, error, session start/shutdown, pause/complete/abandon, and successful lifecycle tool calls that change the obligation key.

## Retry prompt requirements

The first retry should be specific but neutral:

```text
Ferment "<name>" still requires <tool>. The previous turn stopped without a tool call.
Call <tool> now using the required Ferment/phase/step identifiers and payload.
```

The second retry should be stricter:

```text
Lifecycle action still pending (retry 2/2). Do not respond with an announcement or summary.
Emit the required <tool> call now. If the action cannot safely be performed, use the appropriate user-input or recovery mechanism instead of stopping silently.
```

For automated `scope`, remind the model that the call needs the complete plan and P1/P2/P3 gates. Do not attempt to include fabricated values.

For `complete_step`, retain the condition that it may be called only after the linked worker has a completed outcome and completed report.

The prompt must not mention a specific model family.

## Tests

### Pure unit tests

Add focused tests beside the new module covering:

1. Builds stable keys for scope, phase, and step actions.
2. First qualifying stop returns retry attempt 1/2.
3. Second qualifying stop for the same key returns retry attempt 2/2.
4. Third qualifying stop returns exhausted and requests reporting once.
5. Re-evaluating an exhausted key does not request duplicate reporting.
6. State advancement to a different action key provides a fresh budget.
7. An unrelated tool call that does not change the obligation does not reset the budget.
8. Per-Ferment cleanup removes all associated keys.
9. Automated scope maps to `scope_ferment`.
10. Interactive mode returns `none` (guard is automated-only).
11. Paused, terminal, idle, manual-boundary, and ambiguous recovery states return `none` or choice-oriented behavior as designed.
12. `complete_ferment` is classified consistently with the chosen final-completion design.

### Event integration tests

Update/add tests in the co-located Ferment event/index test files:

1. Automated draft + first empty `stop` schedules scope retry 1.
2. Same draft + second empty `stop` schedules scope retry 2.
3. Third empty `stop` schedules no turn and emits one visible exhaustion diagnostic.
4. A successful `scope_ferment` state change causes the subsequent `activate_phase` obligation to start at retry 1.
5. A `read` tool call that leaves the draft unscoped does not silently replenish the old scope budget.
6. Abort clears retry state and schedules no guard turn.
7. Provider error uses the existing error-recovery path and clears the lifecycle-stop budget; an alternating stop/error test pins this reset behavior.
8. Pending plan review suppresses the guard.
9. Interactive mode does not fire the guard.
10. Manual phase boundary does not receive an automatic lifecycle retry.
11. Final `complete_ferment` receives at most one nudge across `turn_end` and `agent_end`.

Replace old tests that assert "cap=1" behavior. Do not keep assertions tied to the obsolete counter implementation.

### TUI E2E regression

Strengthen:

```text
tests/e2e/tui/ferment-oneshot-scope-nudge.test.ts
```

Use the shared `runKimchiSession` fixture, deterministic fake OpenAI responses, isolated HOME/workdir, and trace steps.

Required scripted flow:

1. Response 1: text-only scoping response, no tool call, `stop`.
2. Response 2: text such as "Calling scope_ferment now," still no tool call, `stop`.
3. Response 3: a valid `scope_ferment` tool call with a minimal complete plan and exactly P1/P2/P3 gates.
4. A follow-up response/tool call as needed to demonstrate the Ferment has progressed beyond draft.

Required assertions:

- At least three relevant chat-completion requests occurred.
- The third response actually invoked `scope_ferment`; do not treat prose mentioning the tool as success.
- The tool call succeeded.
- The Ferment is planned with persisted phases, or an equivalent user-visible/next-request assertion proves that `activate_ferment_phase` is now the expected lifecycle action.
- No duplicate retry messages were scheduled for one stop.
- The session did not terminate after response 2.

## Acceptance criteria

- A one-shot Ferment survives two consecutive text-only `stop` responses with empty tool calls during scoping.
- A valid third-response `scope_ferment` call persists a plan and allows the lifecycle to proceed.
- Retry budget is two retries per unchanged lifecycle obligation.
- Retry budget changes only when the obligation changes or is explicitly cleared, not merely because any tool was called.
- Exhaustion is visible and emitted once; no lifecycle state is fabricated or silently skipped.
- `stopReason === "error"` uses a separate recovery path and clears the lifecycle-stop budget before scheduling recovery.
- Interactive mode does not fire the guard.
- Final completion does not receive duplicate `turn_end` and `agent_end` nudges.
- Existing tool-using stop nudges and scoping exploration nudges continue to work.
- Unit, integration, and TUI E2E regression tests cover the behavior.

## Verification commands

```bash
pnpm vitest run src/extensions/ferment/lifecycle-obligation-guard.test.ts
pnpm vitest run src/extensions/ferment/nudge.test.ts src/extensions/ferment/events.test.ts src/extensions/ferment/index.test.ts
pnpm run test:e2e:tui -- ferment-oneshot-scope-nudge
pnpm run typecheck
pnpm run lint
```

If the TUI runner does not accept a filename argument, use the repository's supported test-name/filter mechanism or run `pnpm run test:e2e:tui` and record the relevant scenario result.

Do not run `lint:fix` manually; repository hooks handle formatting after edits.

## Implementation sequence

1. Add the pure obligation model, key builder, and retry tracker with unit tests.
2. Integrate the guard into `turn_end` after legitimate user-input handling.
3. Separate provider-error recovery from model-stop retry accounting.
4. Resolve final-completion duplicate suppression.
5. Replace obsolete reactive-counter tests and cleanup calls.
6. Strengthen the TUI E2E test so a real scoping tool call and state advancement are required.
7. Run focused tests, typecheck, lint, and the TUI scenario.

## Handoff notes

- This plan is based only on the local repository and pinned local SDK.
- Treat this as a bug fix, not an opportunity to redesign the Ferment FSM.
- Prefer an extension-hook implementation. No local SDK patch is required for the recommended approach.
- Preserve unrelated working-tree changes.
- The guard is automated-only for this iteration. Interactive mode requires proving the `maybeRunUserInputDropdown` detection is sufficient to distinguish legitimate conversation stops from lifecycle stalls — that validation is deferred to a follow-up.
