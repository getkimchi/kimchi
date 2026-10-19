# Implementation Plan — Fixing Stale Todos

Companion analysis doc: `fix-todos.html` (mechanism, gaps, case study, Codex comparison).
Supporting evidence: `.kimchi/docs/session-01a143b9.json` (decoded session forensics),
`.kimchi/docs/codex-todo-research.md` (Codex comparison).

## Goal

Eliminate the "model claims it's done, todo list disagrees" failure class through five
scoped changes: make write-path atomicity structural, catch dangling requests without
work tools, make staleness pressure per-scope, remind at a regular work-call interval,
and require reconciliation before work resumes after user input, using the same
check-in gate for occasional staleness escalation.

## Constraints

- **Check at meaningful boundaries**: require reconciliation after genuine user input
  when relevant unfinished todos exist, before admitting further work tools. This is
  a routine request-boundary check, not a rare escalation. Do not force a standalone
  conversational turn to perform it. The separate staleness trigger remains bounded:
  at most once per scope write-epoch and two escalation openings per user request.
  Fix 2's once-per-request terminal closure check remains independently bounded.
- **Cache stability (#1166 contract)**: the persisted state block stays a pure function
  of the store. Gate messages and recurring steers use the existing hidden message
  path, appended at the current chronological position. They never rewrite the persisted state block.
- **Dual-surface parity (TUI ↔ ACP)**: the new `confirm_todos` tool and the gate's
  paused state must be mirrored/verified for ACP (`pnpm run test:e2e:acp`).
- **Org policy**: all new behavior gated behind `isResourceEnabled("extensions.todos")`
  and existing steer kill-switches (`steer-events.ts`); gate gets its own kill switch.
- **Repo conventions**: tests co-located as `*.test.ts`; TUI e2e in
  `tests/e2e/tui/`; pnpm/bun/vitest/biome as per project guidelines.

---

## Chunk 1 — Fix 1: Make write-path atomicity structural (hardening, not a live bug fix)

**Depends On**: nothing.

**Problem — verified during plan review**: `executeMarkTodo` / `executeAddTodo` do
read-list → modify → `applyWriteTodos` (whole-list overwrite). This path is **fully
synchronous today** — `applyWriteTodos` in `store.ts` contains no awaits, and the tool
bodies contain none between the read and the write (verified at HEAD *and* at the
#1258 commit). Under JS's event loop, synchronous read-modify-write cannot interleave,
so parallel calls serialize naturally and no live race exists in this code path. The
"found while testing" lost-write recorded in PR #1258's commit message cannot be
attributed to this code — likely a different layer (session-replay, the replaced-session
bug #1210 fixed days earlier, or ACP/widget mirroring), or misattributed.

The goal is to centralize synchronous read-modify-write so callers cannot introduce
an await between reading and committing. Keep the existing synchronous write contract;
adding a queue only for add/mark would introduce a race with direct replacement,
clear, command, and ferment writes that bypass that queue.

**Files Changed**:
- `src/extensions/todos/store.ts` — add a synchronous mutation API:
  ```ts
  export function applyTodoMutation(
    scope: TodoScope,
    sessionId: string,
    mutator: (todos: readonly Readonly<TodoItem>[]) => TodoDraft[] | undefined,
  ): WriteTodosDetails | undefined
  ```
  Read the latest scope list, invoke the mutator, and call `applyWriteTodos` without
  yielding. `undefined` means no commit and no store notification. Pass a detached
  snapshot so a mutator that throws cannot modify stored items. Reject a thenable
  result before committing; an async callback must also fail type checking. Mutators
  must be pure: no reentrant store writes or async side effects.
- `src/extensions/todos/tool.ts` — move add/mark reads and edits inside the mutator.
  Preserve existing unknown-id and no-op result text without emitting a write; capture
  the relevant result data synchronously for tool output.
- Keep replacement, clear, commands, and internal writes synchronous. There is no lock
  or pending mutation to bypass. If async storage is needed later, migrate **all** write
  paths together to session-and-scope-keyed serialization, with explicit rejection
  recovery, cancellation, replay, and session cleanup semantics.

**Accept When**: parallel add/mark calls preserve all changes; replacement and clear
interleaved with mutations respect synchronous call order; no-op and failed mutations
leave the store and write subscribers unchanged. Async mutators are unsupported.

**Test Coverage**:
- `src/extensions/todos/store.test.ts` — mutation ordering with add/mark, replacement,
  and clear; no-op notification suppression; thrown callback leaves state unchanged;
  accidental thenable rejection without committing.
- `src/extensions/todos/tool.test.ts` — concurrent marks and adds, unknown-id and
  no-op behavior. These ordering tests also pass before the refactor: this chunk is
  structural hardening, not a failing-first repro of an existing lost-write bug.

---

## Chunk 2 — Fix 2: Relax the "task work" guard on the closure steer

**Depends On**: nothing (independent of Chunk 1).

**Problem**: the `turn_end` closure steer in `index.ts` requires a non-todo toolResult in
the branch after the last user message. A text-only final turn after work tools in
that same request **already qualifies**. The uncovered case is a request with no work
tool results anywhere after its user message, such as a text-only completion claim
about earlier work while global todos remain unfinished.

**Intentional expansion**: removing this guard also permits one bookkeeping check on
a conversational request with old unfinished todos. Preserve deferred/blocked work;
the model may stop without modifying anything. This is a product tradeoff, not a
completion detector, and must be explicit in the regression specs.

**Files Changed**:
- `src/extensions/todos/index.ts` — in the `turn_end` handler, remove the
  "must contain a non-todo toolResult" condition. Keep all other bounds unchanged:
  - once per user-request epoch (`TODO_CLOSURE_CUSTOM_TYPE` marker in history),
  - suppressed while `isAwaitingUserAnswer(message)`,
  - suppressed when a ferment is incomplete (`restoreFermentV2` check),
  - global scope only, todo write tools available.
- Add suppression when the global list has already been reconciled for the latest
  user input and no successful work tool has finished afterward. Reconciliation may
  be a real assistant/command write, or (once Chunk 5 lands) a successful confirmation.
  A background lifecycle write, failed/no-op mark, or unrelated-scope write does not
  qualify. A newer user message invalidates the earlier acknowledgment.
- Introduce feature-local reconciliation bookkeeping shared with Chunk 5: per session
  and scope, record the accepted input revision, current list version, and monotonic
  successful-work sequence at reconciliation. Check these at terminal closure. A later
  work completion invalidates suppression even when admitted before reconciliation;
  counter resets must not hide that work. A later unacknowledged list change likewise
  invalidates suppression. Replay invalidates unproven acknowledgments; shutdown clears
  session state. Keep these volatile records out of the persisted todo state block.

**Accept When**: a terminal text-only turn with dangling pending/in_progress todos
and no qualifying reconciliation receives exactly one closure steer even when the
whole request contains no work tools; unreconciled conversational requests with old
dangling todos get the same bounded check.
Requests without dangling todos fire nothing. Reconcile→text-only answer produces no
extra closure steer; reconcile→successful work→text-only answer remains eligible.
Suppression applies only when the current global list and latest input were reconciled.

**Test Coverage**:
- `src/extensions/todos/closure.test.ts` — cover a request with no work tools; preserve the existing
  text-only final answer after work tools; conversational reply with old unfinished
  todos; no dangling todos; second terminal turn in the same epoch does not re-fire;
  awaiting-user-answer remains suppressed. Cover reconciliation→text-only suppression,
  reconciliation→work→answer eligibility, newer input, unrelated/background/no-op writes,
  and work completing after reconciliation despite being admitted earlier.
- `tests/e2e/tui/todos-dangling-active.test.ts` — extend the scripted continuation with
  a whole-request-without-work-tools variant, retaining the existing after-work case.
- `tests/e2e/acp/` — matching closure workflow: restore unfinished global todos, send a
  request answered without work tools, verify one cleanup continuation and the resulting
  plan update (or preserved list when nothing needs changing). Also verify a real global
  reconciliation followed by a text-only answer avoids an extra cleanup continuation;
  once Chunk 5 lands, cover confirmation without a store write on both surfaces.

---

## Chunk 3 — Fix 3: Per-scope staleness epochs

**Depends On**: nothing (independent; lands cleanly before or after Chunks 1–2).

**Problem**: one staleness counter per session, reset by *any* todo write — including
writes to a different scope. A model updating its ferment-step list silences staleness
pressure on a neglected global list (Gap 3).

**Files Changed**:
- `src/extensions/todos/store.ts` — require scope on counter get/bump/reset APIs;
  key counters by session and `getTodoScopeKey(scope)`. Add session-wide cleanup for
  replay and shutdown. The store subscription resets only `details.scope`.
- `src/extensions/todos/staleness-steers.ts` — key the threshold tracker's fired bands
  by session **and scope**. Make fire/reset scope-specific and provide session cleanup.
  Expose the highest successfully delivered band for the gate's eligibility check;
  disabled or unsent steers must not count as delivered.
- `src/extensions/todos/index.ts` — for each successful non-todo work tool result,
  increment and evaluate the deduplicated set of the global scope and
  `resolveTodoScope()`, restricted to lists with unfinished items. Thus the global
  list continues aging during step work. Inactive historical step lists and
  lifecycle-managed phase lists do not age; a step resumes its counter when active.
  Include scope in steer details and message text so the model knows which list to
  reconcile. Scope-specific writes reset only that counter and its fired bands.
- Replay/session-tree changes clear all counters and tracker bands for the session;
  shutdown removes session bookkeeping without affecting other ACP sessions.

**Accept When**: a global list continues aging while a step is active and regularly
updated. Step writes neither reset the global counter nor re-arm global bands; global
writes do not reset step bookkeeping. Equal thresholds in different scopes each fire
once. Completed/empty lists do not generate pressure.

**Test Coverage**:
- `src/extensions/todos/store.test.ts` — counter independence and session cleanup.
- `src/extensions/todos/staleness-steers.test.ts` — independent fired bands and resets
  across scopes and sessions; disabled delivery does not satisfy gate eligibility.
- `src/extensions/todos/index.test.ts` — global and active-step lists age together;
  step writes do not suppress or repeatedly re-arm global steering; inactive historical
  scopes do not age; replay resets every scope in only the current session.
- Matching TUI/ACP e2e workflow: unfinished global list alongside step work and step
  writes still produces scope-labelled global pressure.

---

## Chunk 4 — Fix 4: Remind every 10 successful work calls

**Depends On**: Chunk 3 (per-scope counters and delivery bookkeeping).

**Problem**: staleness steers currently fire at 9/17/25 calls and then stop forever.
A longer fixed ladder merely moves that ceiling. Use a regular interval instead.

**Files Changed**:
- `src/extensions/todos/staleness-steers.ts` — replace the finite threshold array with
  `TODO_STALENESS_INTERVAL = 10`. Remind at 10, 20, 30, and every subsequent multiple
  of 10 successful work calls since that scope's last write or successful confirmation.
  Retain scope-specific delivery bookkeeping from Chunk 3; store the highest delivered
  interval boundary rather than an unbounded set of every fired boundary.
- Evaluate reminders after each counted successful work result. Emit at most one per
  scope per evaluation; if a counter jumps across several boundaries, send one reminder
  for the highest crossed boundary rather than replaying a burst of old reminders.
  Disabled/unsent reminders do not advance the last-delivered boundary.
- Keep scope-labelled wording: at 10/20 calls, request a refresh at the next natural
  breakpoint; from 30 onward, add "remove obsolete items or complete items whose work
  is done". The schedule is regular; only wording becomes stronger.
- A real write or successful confirmation resets only that scope's counter and delivery
  boundary. User input alone resets neither. Completed/empty lists do not generate
  pressure. Reminders remain hidden chronological messages, outside the persisted
  state block, and continue even if the hard gate's escalation budget is exhausted.

**Accept When**: 83 successful work calls without reconciliation produce eight reminders
at 10 through 80; call 90 produces the ninth. There is no final reminder ceiling.
An update or confirmation at call 23 restarts that list's schedule: the next reminder
is after 10 additional successful work calls. Other scopes keep their own schedules.

**Test Coverage**:
- Extend `src/extensions/todos/staleness-steers.test.ts` (introduced in Chunk 3):
  interval boundaries, no duplicates within an interval, recurrence beyond 85, bounded
  tracker storage, count jumps without bursts, disabled delivery, wording, and resets.
- Update existing staleness assertions in `src/extensions/todos/index.test.ts` and
  `src/extensions/todos/prompt-block.test.ts`; assert unchanged persisted state bytes.
- Matching TUI/ACP scripted work produces repeated scope-labelled reminders and resets
  the schedule only for the reconciled scope. Recurrence with the gate disabled is
  verified at unit level instead (index.test.ts: kill switch on — every work call
  admitted, reminders still recur at 10/20/30 with the stronger wording), which pins
  the independence claim without a dedicated e2e; the escalation-budget-exhausted
  variant is covered by the armed-gate escalation tests.

**Not in scope**: transient per-turn staleness-count injection. Reuse the hidden-steer
path; revisit context assembly only if interval reminders prove insufficient.

---

## Chunk 5 — Fix 5: Reconcile after user input and prolonged work

**Depends On**: Chunk 2 for shared reconciliation records; Chunk 3 for scope
bookkeeping; Chunk 4 for the staleness trigger.
The user-input trigger does not depend on elapsed calls or prior reminders.

**Problem**: new user input may change the course of action, making an existing todo
list inaccurate before any further work starts. During a long request, work can also
outpace the list despite reminders. Require the assistant to reconcile the list against
both completed work and the user's latest direction before admitting more work tools.
Updating the list or explicitly confirming it is accurate satisfies the check. A gate
does not prove the assessment is correct or prevent the assistant from answering in text.

### State and triggers

**State** — new module `src/extensions/todos/checkin-gate.ts`: maintain pending checks
per session and scope, with reasons `user_input` and/or `staleness`. Track the latest
received user-input revision, the revision reconciled for each scope, the last delivered
reminder boundary, scope write-epochs, and a separate request-wide staleness-opening budget.
Use explicit operations for reconciliation, epoch reset, pending-scope queries,
subscriptions, replay, and shutdown; closing a gate alone must not erase its budgets.

**Relevant lists**: use Chunk 3's deduplicated global-plus-active-step set, restricted
to lists with unfinished items (`pending`, `in_progress`, or `blocked`). Empty and
fully completed lists need no user-input check. Lifecycle-managed phase lists and
inactive historical step lists are excluded. If a step becomes active later in the
request, check its list against the current user-input revision before admitting work.
Fix 2 retains its narrower pending/in_progress-only terminal closure condition.

**User-input trigger**:
- On each genuine user message received from a non-extension source (interactive
  or rpc), advance the input revision and mark relevant unfinished lists as
  requiring reconciliation, regardless of age — including steering input received
  during work, on both surfaces. Queued follow-ups (`streamingBehavior: "followUp"`)
  are the receive-side exception: they arm at delivery — the message entering
  history — not at receipt (Decision Log 11). Harness custom messages, reminders, and replayed
  history are not new input. (The SDK `input` event has receive semantics, not
  acceptance semantics: another input handler may still consume the submission
  afterwards with `{ action: "handled" }` — e.g. a cancelled vision gate — after the
  revision has advanced. The resulting check against a revision the model never
  saw is bounded and self-correcting: the next real input re-arms it legitimately.)
- Preserve open gates, staleness counters, and delivered reminder boundaries. A new message changes
  what must be reconciled; it never counts as reconciliation by itself.
- A new request may reset the request-wide staleness-opening budget, but the routine
  user-input check is independent of that budget and cannot be suppressed by it.
- Repeated input supersedes the earlier revision. Pending checks coalesce per scope;
  confirmation against an older revision cannot unlock work under newer instructions.
- Supply one reconciliation instruction per received input revision when checks are
  pending, through the normal model-context path. A text-only reply need not call a
  todo tool; its check remains pending before any later work tools.

**Staleness trigger** (all must hold):
- staleness ≥ `CHECKIN_HARD_THRESHOLD = 50` for a relevant unfinished list,
- a reminder at boundary 30 or later (the stronger wording) was successfully delivered
  for that scope in this epoch without reconciliation; disabled/unsent reminders do
  not qualify. This replaces the old ≥25-band requirement,
- no staleness gate has opened for that scope epoch, and fewer than two staleness
  escalation openings occurred in this user request.
A scope already pending for user input gets the additional reason without duplicate
messages. The frequency cap applies only to staleness escalation, not routine checks.

**Common prerequisites**: resource enabled, `todo_checkin` kill switch enabled, and
an active reconciliation tool. (Tool availability is checked globally, not per
pending scope — the todo tools are scope-agnostic: every write tool and
`confirm_todos` accepts a scope argument.) Do not block work when
reconciliation tools are unavailable. Recheck prerequisites on enforcement too.

### Enforcement and reconciliation

Use the existing `tool_call` extension hook in `index.ts`, returning
`{ block: true, reason }` for work tools while any relevant check remains pending.
Work-class means non-read-only: write, execute, and unknown-class tools are blocked
(`submit_plan` included — the plan handoff must carry reconciled todos), while
read-only tools and `questionnaire` pass (Decision Log 10). The pinned SDK exposes
this hook and `src/extensions/permissions/index.ts` already
uses it. No upstream patch or permission-mode changes are needed; allowed calls still
pass through normal permission checks.

Permit todo reconciliation tools while gated. Instructions name each pending scope,
render its current list, and ask the assistant to compare it with work performed and
the user's latest direction: add newly requested work, remove obsolete items, revise
statuses, or confirm the list still fits. Explicit cancellation is handled by clearing
or replacing the affected lists; it is not an automatic bypass on receipt of text.

The assistant can reconcile before its first work tool without sending a separate
conversational response. Reconciliation and work may share a tool batch only if execution
ordering guarantees reconciliation completes first. Do not assume parallel tools execute
in response order; otherwise use a reconciliation tool round followed by work. A work
call already admitted before a new input revision or staleness crossing may finish;
subsequent calls must pass the check. Repeated blocked calls return current instructions
without queuing repeated steer messages.

**Confirmation tool** — register `confirm_todos` alongside existing tools:
```ts
confirm_todos({
  scope?: unknown,
  inputRevision: number,
  expected: Array<{ id: number; status: "pending" | "in_progress" | "blocked" | "completed" }>
}): { text, details }
```
- Include the current `inputRevision` in reconciliation instructions. Verify it still
  matches the session's latest received input; stale confirmations leave checks pending.
- Match the complete current id/status set, rejecting duplicate, missing, extra, or
  invalid ids/statuses. Validate scope using existing tool rules and require explicit
  scope when reconciling a list outside auto-scope.
- A successful confirmation records reconciliation for that scope and input revision,
  closes its pending reasons, updates Chunk 2's reconciliation record, and resets only
  its counter and delivered boundary. A
  mismatch returns actual state and current revision without unlocking work.
- A real todo write also reconciles only its scope. Capture the accepted input revision
  at tool admission and acknowledge that revision only: a write admitted before newer
  user input may update the store but cannot satisfy the newer check. Carry this context
  through the write notification path. Command mutations likewise capture their revision.
  Background ferment lifecycle synchronization must not silently acknowledge user input.
- Unknown-id errors and no-op marks do not emit writes and cannot bypass the gate.
  For an unchanged accurate list, use `confirm_todos`.
- Keep confirmation separate from `isTodoWriteToolName` and from work-tool classification:
  it is not a write, does not satisfy early-nudge adoption, and never increments work or
  staleness counters. It publishes gate changes without synthetic todo-store writes.

**Interaction with closure**: apply Chunk 2's shared suppression rule. A successful
reconciliation of the current global list for the latest input, followed only by text,
needs no extra cleanup turn. Work completing afterward or new input invalidates that
suppression. A text-only answer without reconciliation remains eligible for Fix 2's
once-per-request check; neither the answer nor reminder satisfies the pending gate.
Todo corrections or confirmation during closure may reconcile their scopes; otherwise
checks stay pending before future work. Step reconciliation alone cannot suppress a
global-list closure check.

**Lifecycle and escape hatches**: resource disablement, the kill switch, or unavailable
reconciliation tools release enforcement and notify surfaces. Re-evaluate unreconciled
input if enabled again. Replay/session-tree changes rebuild the current branch's user
revision and list state; require reconciliation before resumed work on relevant unfinished
lists without treating every historical message as fresh input. Shutdown disposes all
session state and subscriptions. Ordinary new user input never dismisses a check or
resets staleness.

### Surfaces and telemetry

- TUI (`src/extensions/todos/widget.ts`): show `⏸ todo check-in pending`; subscribe
  to gate changes so input, confirmation, and closure repaint without todo writes.
- Shared gate module: publish session-scoped notifications for pending revisions,
  reasons, and open/close transitions, including an input revision change while already
  pending. Keep gate state out of the persisted todo state block.
- ACP (`src/modes/acp/plans.ts`): subscribe to gate changes and store writes. Add
  `todoCheckin: { inputRevision: number, pendingScopes: TodoScope[] }` under plan
  `_meta["kimchi.dev"]`, including all relevant pending scopes even when ACP displays
  a narrower list. Include metadata in deduplication; emit changes with unchanged
  entries and explicit empty `pendingScopes` on closure. Dispose both subscriptions.
  Confirmation uses ordinary tool-call/result presentation, not synthetic plan writes.
  Verify notifications without assuming every client renders vendor metadata as a badge.
- Telemetry (`src/extensions/steer-events.ts`): distinguish routine `user_input` checks
  from `staleness` escalations; record actual openings, reconciliation by write/confirm,
  mismatches, and stale-revision attempts. Add `todo_checkin` to `SteerKind` and
  `STEER_DISABLE_FLAGS`, extending reason/outcome types where necessary. Avoid counting
  repeated input on an already pending scope as repeated staleness escalation.

**Accept When**:
- User input with relevant unfinished todos requires a real update or confirmation
  before work. Empty/completed lists do not require a check. Text-only replies remain
  possible without reconciliation; deferred work stays gated.
- A change of direction is reflected in the list before subsequent work is admitted.
  An unchanged plan can be confirmed without a write. Cancellation can clear the list.
- Input received while gated preserves the check and staleness, and invalidates older
  acknowledgments. A background write cannot silently satisfy it.
- Ignoring reminders for 50+ calls still produces the bounded staleness escalation.
  Its budget cannot bypass routine request-boundary reconciliation.
- Incorrect confirmation, no-op marks, and unrelated-scope writes do not unlock work.
  Work resumes when all relevant pending scopes are reconciled for the current revision.
- Confirm/update→text-only answer adds no cleanup turn; confirm/update→work→answer
  still permits the bounded terminal check for dangling global todos.

**Test Coverage**:
- `src/extensions/todos/checkin-gate.test.ts` — both triggers, scope/session isolation,
  revision coalescing, blocked-only lists, staleness caps, preserved counters on input,
  stale acknowledgments, scope activation, replay, disable/re-enable, and cleanup.
- `src/extensions/todos/tool.test.ts` — complete-set confirmation, revision match/mismatch,
  unchanged-plan confirmation, closure suppression records, real/no-op/unrelated writes,
  and admitted-old-revision writes.
- Tool-hook integration — reconciliation before first work, parallel admission ordering,
  input during work, no work side effects when blocked, and normal permission enforcement.
- `src/modes/acp/plans.test.ts` — unchanged-entry metadata transitions, newer revisions
  while already pending, explicit clearing, deduplication, isolation, and disposal.
- Matching TUI/ACP e2e workflows: changed-direction input→update→work; unchanged-plan
  input→confirm→work; text-only reply leaves check pending; input while gated requires
  reconciliation against the latest direction; explicit cancellation clears the list;
  ignore staleness reminders→gate→mismatch→confirm→work. Use deterministic shared fixtures
  and assert user-visible behavior, metadata, and absence of blocked tool side effects.
  ACP note: the gate, per-scope staleness tracking, and outcome telemetry live in the
  shared extension both surfaces run, exercised on ACP by todos-checkin (closure +
  gate + confirm→work with plan metadata, gated-input revision supersession, and
  staleness escalation → wrong confirm → right confirm → resume) and plan-updates
  snapshots. The remaining TUI-only workflows: per-scope staleness during a
  ferment step — drivable on ACP via a seeded planned ferment plus a "Resume"
  elicitation answer, as plan-updates.test.ts does, an elaborate setup with
  known CI flakiness, so deferred — and submit_plan (elicitation-backed
  review driver).

**Files Changed**: new `checkin-gate.ts`; `tool.ts` (confirmation and write revision
context); `store.ts` (write origin/revision notification context); `index.ts` (accepted
input handling, both triggers, tool-call enforcement, lifecycle); `widget.ts`;
`steer-events.ts`; command mutation adapters; `src/modes/acp/plans.ts`; co-located
unit/integration tests and matching TUI/ACP e2e tests.

---

## Phasing

| Phase | Chunks | Rationale |
|---|---|---|
| 1 | Chunk 1 (hardening) | cheapest change; makes atomicity structural before later chunks touch the write path |
| 2 | Chunk 2 (guard) | small, externally validated (Codex #21327) |
| 3 | Chunk 3 (per-scope) | prerequisite for meaningful recurrence |
| 4 | Chunk 4 (interval reminders) | builds on 3; recurring pressure without a final ceiling |
| 5 | Chunk 5 (reconciliation gate) | routine checks after user input plus bounded escalation after ignored reminders |

Ship in dependency order. Chunk 2 supplies write-based closure suppression first;
Chunk 5 reuses it for confirmations. Revert dependent chunks together when necessary.

## Verification Strategy

- `pnpm run test` (unit/integration) after every chunk; regression tests written to
  fail before each fix where practical.
- `pnpm run test:e2e:tui` and `pnpm run test:e2e:acp` after Chunks 2–5: closure,
  scope-labelled interval reminders, closure suppression, and gate state all affect both surfaces.
  Use the shared deterministic fixtures and bundled `kimchi-tmux` for live TUI checks.
- `pnpm run check` (lint + typecheck) before each PR.
- Post-ship: watch steer telemetry (#1291 framework) for routine-check versus
  staleness-escalation rates, write/confirm outcomes, mismatches, and blocked calls.
  Measure routine reconciliation overhead separately from escalation effectiveness.

## Decision Log

1. **Synchronous mutation API**: centralize read-modify-write without introducing a
   partially adopted async queue. Async storage requires a coordinated migration of
   every writer; it is outside this hardening chunk.
2. **Guard removed with explicit scope expansion**: completion detection from text is
   unreliable. Permit one check even on conversational requests with old todos; preserve
   deferred work and allow no-op closure. Suppress duplicate cleanup after reconciliation
   for the latest input when no work followed. Requests with prior work tools already qualify.
3. **Every 10 successful work calls, without a ceiling**: simpler than a finite ladder;
   each scope resets on its own write/confirmation. Wording strengthens from 30 calls.
   Keep hidden messages and kill switches; transient injection remains deferred.
4. **Gate shows the current state in its message**: comprehension beats a
   pseudo-proof; the read-back still forces per-item parsing. No protocol can force the
   comparison step — attestation is the ceiling, and a wrong-but-certified list is at
   least attributable and measurable.
5. **Two triggers, one reconciliation mechanism**: user input can change the plan,
   so relevant unfinished lists require reconciliation before further work regardless
   of age. New input preserves existing checks and staleness; cancellation is reflected
   by clearing/replacing the list. Text-only replies do not require a tool check-in.
6. **Caps apply to staleness escalation only**: a delivered reminder at 30+ and 50 calls
   without reconciliation precede escalation, limited to two openings per request.
   Routine checks after user input bypass this escalation budget; they are not rare.
7. **Latest input must be acknowledged**: confirmation includes the input revision;
   writes acknowledge only the revision at admission. An older call or background
   synchronization cannot silently clear a newer user-input check.
8. **Chunk 1 reframed after verification**: the read-modify-write is synchronous
   end-to-end (no awaits at HEAD or at #1258), so no live race exists in this code
   path; the #1258 "found while testing" lost-write is unattributed to it. The mutation
   API remains worthwhile as structural hardening — and the same overstatement exists
   in `fix-todos.html` (Gap 1 is framed as the highest-probability cause; it is at
   best a latent risk). Amend the HTML when convenient.
9. **Third arming reason: plan submission** (added during implementation,
   product-approved): `submit_plan` ends the turn for user review, so no other
   hygiene mechanism runs at that boundary — work completed while finalizing
   the plan froze into the handoff unreflected (observed live). A successful
   submission arms the same gate with reason `plan_submission` for the
   review-outcome turn. The mechanism stays "two triggers, one reconciliation
   path": plan submission reuses the user-input-style arming.
10. **The gate blocks non-read-only tools**: write, execute, and unknown-class
    tools are blocked while a check is pending — `submit_plan` included, since
    the handoff must carry reconciled todos. Read-only tools and `questionnaire`
    pass: they cannot make the list staler, and the model may need to inspect
    state or ask the user in order to reconcile against the latest direction.
    The classification reuses the permissions taxonomy — one source of truth.
    Review handoffs are named explicitly (`REVIEW_HANDOFF_TOOL_NAMES`:
    `submit_plan`, `workflow_submit_result`, `workflow_submit_questions`)
    instead of trusting the read-only exemption: the taxonomy's concern is
    mutation, the gate's concern is the handoff — both workflow submissions
    are read-only for permissions yet end the turn for user/orchestrator
    review, so they are gated like any work tool.
11. **Queued follow-ups defer arming to delivery**: an input queued with
    `streamingBehavior: "followUp"` is delivered only after the current run
    ends; arming at receipt would block work against a direction the model
    cannot see and let a blind confirmation consume the revision. The revision
    advances and the check arms when the message enters history
    (`message_start`), attributed causally rather than by timing: a user
    message matches (in order) a recent immediate input's text (already
    advanced at receipt), a queued follow-up's text (upstream may rewrite the
    text between the input event and queueing — skill/template expansion, a
    later input handler's transform), or — only when no unconsumed immediate
    input could have produced the message — the oldest queued follow-up
    positionally, which also keeps stale queue entries (dropped by upstream's
    `clearQueue`) from double-advancing a later resubmission of the same
    text. Deferred deliveries send no separate instruction steer: the block
    reason carries the instructions with the model already looking at the new
    direction. An empty deferred queue at a user message means the message is
    an idle or steered prompt's delivery: when its text does not match (a
    rewritten prompt), the oldest unconsumed recent entry is dropped
    positionally — mirroring the follow-up fallback — so leftovers cannot
    block a follow-up delivery that arrives before the agent_end reset.
    Extension-sourced follow-ups (e.g. the ferment plan-confirmation reply)
    are filtered at the input event and never queued, but their delivery
    still produces a user message_start; they are sent at turn_end, after any
    user follow-up queued during the run, so they cannot overtake one today.
12. **Check-in outcomes are attributed, not watched**: the instruction fires
    carry no generic outcome watcher (it counted any todo write as "complied"
    and expired confirmations); one `complied` is emitted per opening — when
    the LAST pending list closes, not once per list — by write or confirm,
    carrying the opening's `steer_id`. Mismatches emit "repeated" with the
    mismatch method and the same `steer_id`; a confirmation with nothing
    pending emits nothing; and the `steer_id` is cleared whenever no check
    remains (replay, silent empty-closures) so a later opening cannot
    inherit a stale one.

## Risks

- **Gap 1 was overstated in the companion doc**: `fix-todos.html` presents the
  parallel-write race as the highest-probability cause; verification shows the code
  path is atomic today. Amend the HTML (Gap 1 card + summary table) when convenient.
- **Rubber-stamped confirmations** (model attests without reconciling): accepted and
  measured; changes the failure from "silent drift" to "certified drift" (diagnosable).
- **Routine reconciliation adds tool overhead**: after user input with unfinished
  work, the assistant must update or confirm before continuing. Coalesce repeated
  input and permit text-only replies; do not force a standalone conversational turn.
  Staleness escalation alone has a rarity budget; kill switch permits opt-out.
- **Concurrent input and writes**: revision-aware acknowledgments prevent older tool
  calls from unlocking work under changed instructions. Parallel batch ordering needs
  explicit integration coverage on both surfaces.
- **ACP drift**: new tool + paused state is exactly the dual-surface parity trap the
  repo guidelines warn about; Chunk 5 carries an explicit ACP e2e requirement.
- **Interval and gate tuning**: reminders every 10 successful work calls and escalation
  at 50 are initial values; use telemetry to assess frequency and disruption.

## Open Questions

1. **Fix 4 option (b)** — transient per-turn staleness count: defer until interval
   reminders' telemetry is in. Recurring reminders already continue without a ceiling.
2. **Should `confirm_todos` read-back include `note`/`activeForm` fields?** Minimum
   viable is the complete id+status set; richer read-backs raise attention but friction.
3. **ACP client rendering of vendor metadata** — the server will emit gate state under
   plan `_meta`; clients may need separate UI work to show a pause badge. Protocol
   parity is verified through notifications and tool blocking, independent of that UI.
