# Ferment V2 runtime guide

Ferment V2 is an experimental, session-branch-scoped objective controller. It keeps one objective active across turns and uses the ordinary Todo tools for tactical work. It does not create Ferment V1 phases, workers, or worktrees.

Enable `extensions.ferment-v2` under `/resources` → **Experimental**, then restart Kimchi. It is disabled by default. The extension does not activate in an agent-worker process, and a run requires every Ferment V2 and Todo tool to be available.

## Journal state

V2 persists through the native session journal using custom type `kimchi_ferment_v2_state`. The schema-v1 entries are:

- `put`: a complete `fermentV2` snapshot.
- `clear`: a tombstone containing the current ID and revision.

Create, edit, status changes, accounting, evaluations, and guard counters append `put` entries. Clear appends a matching tombstone. Replay ignores malformed entries and only applies a clear when its ID and revision match the current state.

The persisted state includes:

- `id`, `revision`, `objective`, and `status` (`active`, `paused`, `blocked`, `budget_limited`, or `complete`);
- optional blocked reason, self-reported completion confidence, and last evaluation;
- consecutive-error and unchanged-continuation counters;
- assistant token usage, optional token budget, active time, and timestamps.

Objectives are trimmed and limited to 4,000 characters. Mutations are fenced by both ID and revision, so a stale turn cannot update an edited or replaced objective.

## Commands

| Command | Behavior |
| --- | --- |
| `/ferment-v2 <objective>` | Create an active revision 1 and queue a hidden start steer. An unfinished replacement asks for interactive confirmation; headless replacement is rejected. A completed run can be replaced directly. |
| `/ferment-v2 --tokens 50k <objective>` | Set a positive per-run token budget. `--tokens` overrides `fermentV2.defaultTokenBudget`. |
| `/ferment-v2` | Show status, blocked reason, revision, objective, active time, evaluations, latest verdict/reason, and currently valid commands. |
| `/ferment-v2 edit [objective]` | Checkpoint active time, increment the revision, reset error/stall counters, abort an evaluator, and steer work to the new objective. A retained Todo list must be reconciled for the new revision. |
| `/ferment-v2 pause` | Persist `paused`, stop automatic continuation, abort evaluation, and send a cooperative stop steer when an agent turn is running. A running operation is not forcibly rolled back. |
| `/ferment-v2 resume` | Reactivate a paused or blocked run, reset guard counters, and queue a hidden start steer. Exhausted budgets and completed runs cannot resume. |
| `/ferment-v2 clear` | Append a clear tombstone, remove the current run from the selected branch, abort evaluation, and cooperatively stop a running turn. |

Management mutations are serialized per session. Before an active run or evaluator is changed, V2 asks the current turn to stop after its running operation and waits for it to settle. User Todo mutations use the same boundary, then V2 reads the updated list before continuing. Read-only commands remain immediate.

## Settings

Under the `fermentV2` key in `~/.config/kimchi/harness/settings.json`, the defaults are `autoResume: true`, `maxUnchangedContinuations: 3`, `maxConsecutiveErrors: 3`, `defaultTokenBudget: unset`, and `evaluationTimeoutMs: 180000`. `autoResume` affects only the interactive session-start kick; invalid or missing values fall back to these defaults. An explicit command-line `--tokens` value overrides `defaultTokenBudget`.

## Runtime flow

```text
create / edit / resume
        │ append active snapshot + hidden steer
        ▼
turn_start → work and Todo writes → turn_end
                                      │
                        checkpoint time and assistant usage
                        budget reached? → budget_limited, stop
                                      ▼
                         agent_end captures conversation
                                      ▼
                         agent_settled gate
                                      │
                 one bounded, tool-free evaluator call
             ┌──────────────┼──────────────┬──────────────┐
             ▼              ▼              ▼              ▼
         continue          met       impossible      unavailable
       hidden follow-up  + complete    blocked          paused
                         Todo → final answer
```

The core agent marks a run inactive before dispatching `agent_settled`. V2 therefore treats an in-flight evaluator as busy even though the core context reports idle.

At `turn_start`, V2 records the active session/ID/revision, starts active-time accounting, and captures a progress fingerprint. At `turn_end`, it accounts the assistant message and detects budget, abort, or error. `agent_end` stores the full conversation for the settled check. At `agent_settled`, V2 evaluates only if the run is still active and the captured marker still matches.

## Prompt and Todo contract

V2 has no `before_agent_start` handler and does not mutate the system prompt. Its `context` handler removes stale V2 snapshots and inserts one hidden `kimchi_ferment_v2_context` message containing status, objective, token budget, and bounded durable lessons. The ordinary Todo extension injects current Todo state separately in the transient request context; neither injection becomes a permanent transcript message.

The active context tells the agent to:

- keep one visible tactical Todo list and leave it visible;
- add Todos when objective-required work is discovered;
- preserve compact `Decision:`, `Evidence:`, or `Dead-end:` notes for compaction;
- settle every Todo before attempting completion; and
- call `update_ferment_v2` only after the final Todo result, as the only tool call in that response, without a final answer.

Todo writes use normal scope resolution. Omitted scope is auto-routed; agent workers use global scope. V2 accepts observations only from the currently resolved scope and binds them to the current session, V2 ID, and revision. A visible list is required for completion, and every item must be completed for the `complete` gate. An explicit `blocked` update is immediate.

Terminal Todo notes become at most five bounded durable lessons. Only lessons prefixed `Evidence:` are evaluator evidence; unprefixed completed notes are decisions, and blocked notes are dead ends.

`update_ferment_v2 complete` records a runtime-only completion claim and terminates the working turn. Once the Todo list is complete, assistant prose is suppressed until evaluation finishes, so an unaccepted candidate cannot reach TUI, print, JSON, or ACP consumers. The claim is not proof and is not required for a `met` evaluator result to complete a run; if present, its self-reported confidence is copied to the completed state. A `met` verdict queues one visible, tool-free final-answer turn and headless mode waits for that turn to settle. `update_ferment_v2 blocked` persists immediately and records its reason.

## Settled evaluation

The evaluator uses the session model in single-model mode. With multi-model enabled, it resolves the first configured `judge` role and falls back to the session model if that lookup fails. It makes one tool-free `completeSimple` call with a 180-second default timeout (`fermentV2.evaluationTimeoutMs` is configurable), a reasoning-aware token limit, and provider JSON mode for Moonshot. Each call is recorded as a child Pi session linked to the working session, so its prompt, response, model, activity, and usage stay out of the working journal.

Its input is the objective, bounded Todo state (8,000 characters), at most five lessons, and the newest transcript units (16,000 characters). Tool calls stay paired with linked results where possible; thinking is removed. A `met` verdict is accepted only when every check is met, names a plausible failure mode, cites retained evidence, uses known Todo IDs, and covers every settled Todo. Only linked tool results and `Evidence:` lessons count as authoritative evidence. Claims, plans, tool calls, file edits, decisions, dead ends, and exit status alone do not.

Verdicts have these effects:

- `continue`: persist the evaluation and queue one hidden `followUp` continuation while all gates still pass. A reason is included in the hidden checkpoint steer.
- `met`: complete only when the current revision has a non-empty visible Todo list whose items are all completed; otherwise remain active and continue with the missing-Todo reason.
- `impossible`: persist `blocked` with the evaluator reason.
- `unavailable`: persist the evaluation and pause. Missing model/authentication, timeout, cancellation, call failure, malformed output, and truncated output all fail closed after that single call.

## Gates and stop conditions

Evaluation and continuation require an active current revision, no pending user message or user mutation, all V2 and Todo tools, and a non-stale session context. A pending user message or mutation invalidates the verdict; a completed evaluator response remains accounted in its child session even when the verdict is discarded. Missing tools abandon evaluation and release a waiting headless command.

An aborted agent turn pauses immediately. Agent errors are counted once at the settled run boundary, not once per retry `turn_end`; three consecutive errors pause by default. Three unchanged continuation checkpoints pause by default when there was no substantive active work and the canonical fingerprint did not change. Pending-only Todo additions and display-only reordering do not count as progress; starting or settling a Todo, revising its active fields, adding durable lessons, or using a substantive work tool does.

Token usage is checkpointed at `turn_end`. If the run reaches its token budget, it becomes `budget_limited` and no evaluator or continuation is started for that turn. Active time is accumulated only while an active agent turn is running; it is checkpointed on turn end and management mutations.

## Replay, restart, compaction, and headless runs

`session_start` and `session_tree` replay the selected session branch. Rewind and fork therefore select independent V2 histories. After compaction or branch navigation, V2 replays the latest state and Todo writes and rebuilds the context message. Durable Todo notes can remain available as lessons after terminal Todos leave the current list. Explicit `/ferment-v2 resume` restores the persisted guard counters only to reset them in its own commit; ordinary replay preserves them.

An active run schedules a deferred automatic resume only for an interactive UI session, after checking for busy state, pending messages, and unchanged ID/revision. Headless `session_start` deliberately does not compete with the incoming prompt. Headless create, edit, and resume commands wait only when they successfully queue a turn; waiters resolve on terminal state, clear, replacement, or when a continuation cannot be queued (for example, tools are unavailable or synchronous context is stale).

Runtime-only state is rebuilt on replay; a pending continuation or terminal-feedback marker is retained only when its same-session ID/revision still matches the replayed V2, and is otherwise discarded. Cross-session replay resets it, along with active/failed turn markers, completion claim, captured conversation, evaluator abort controller, active-time start, progress fingerprint, and in-memory Todo/lesson bindings. The journal persists the objective state, accounting, evaluations, and guard counters.

## Visibility, telemetry, and benchmark accounting

V2 control/context messages and the `get_ferment_v2`/`update_ferment_v2` tools are hidden from normal tool rendering and bypass permission prompts. Evaluation details are not emitted as visible transcript text. `/ferment-v2` is the supported user-facing status surface; there is no dedicated V2 status-line segment.

The extension emits these lifecycle events: `ferment-v2:started`, `ferment-v2:replaced`, `ferment-v2:edited`, `ferment-v2:completed`, `ferment-v2:blocked`, `ferment-v2:paused`, `ferment-v2:stalled`, and `ferment-v2:evaluated`. Built-in telemetry subscribes only to `ferment-v2:evaluated` and records the V2 ID, verdict, count, evaluator model, token buckets, total tokens, and cost. It does not record the evaluator reason or objective, and unavailable evaluations do not emit an evaluated telemetry record.

V2 runtime accounting describes the working session's assistant turns. Evaluator usage belongs to its child sessions. The Terminal-Bench adapter recursively scans every discovered `sessions/**/*.jsonl`, sums valid assistant entries, and includes cache read/write in the input total, so working, evaluator, and other child sessions are counted once through the same path.

## Ferment V1 boundary

Ferment V1 remains the default-enabled, cross-session project mode. It persists JSON files under `.kimchi/ferments/`, tracks phases and steps, and owns workers, worktree metadata, and its own lifecycle runtime. See [docs/ferment.md](ferment.md) and [the V1 schema](ferment-storage-schema.md). Ferment V2 is a separate `extensions.ferment-v2` resource and does not migrate or replace V1 state.

## Implementation references

- [V2 extension](../src/extensions/ferment-v2/index.ts), [reducer](../src/extensions/ferment-v2/reducer.ts), [prompt](../src/extensions/ferment-v2/prompt.ts), [evaluator](../src/extensions/ferment-v2/evaluator.ts), and [types](../src/extensions/ferment-v2/types.ts)
- [V2 unit tests](../src/extensions/ferment-v2/index.test.ts) and [evaluator tests](../src/extensions/ferment-v2/evaluator.test.ts)
- [V2 TUI flow](../tests/e2e/tui/ferment-v2-mode.test.ts) and [headless smoke coverage](../tests/smoke/ferment-v2-print-exit.test.ts)
