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

Objectives are trimmed. Mutations are fenced by both ID and revision, so a stale turn cannot update an edited or replaced objective.

## Commands

| Command | Behavior |
| --- | --- |
| `/ferment-v2 <objective>` | Create an active revision 1 and queue a hidden start steer. An unfinished replacement asks for interactive confirmation; headless replacement is rejected. A completed run can be replaced directly. |
| `/ferment-v2 --tokens 50k <objective>` | Set a positive per-run token budget. `--tokens` overrides `fermentV2.defaultTokenBudget`. |
| `/ferment-v2` | Show status, blocked reason, revision, objective, active time, evaluations, latest verdict/reason, and currently valid commands. |
| `/ferment-v2 edit [objective]` | Immediately checkpoint active time, increment the revision, reset error/stall counters, abort an evaluator, and queue a steer to the new objective. The current agent operation may finish and its usage is accounted, but old-revision prose stays hidden and a not-yet-started Todo write is blocked. A retained Todo list must be reconciled for the new revision. |
| `/ferment-v2 pause` | Persist `paused` and stop automatic continuation after active agent work settles. |
| `/ferment-v2 resume` | Reactivate a paused or blocked run, reset guard counters, and queue a hidden start steer. If evaluation already accepted the run, retry only final-answer delivery. Exhausted budgets and completed runs cannot resume. |
| `/ferment-v2 clear` | Append a clear tombstone and remove the current run from the selected branch after active agent work settles. |

Management mutations are serialized per session. Edit commits the next revision immediately, aborts only a running evaluator, and queues its steer behind the operation already in flight. Revision fencing prevents the old turn from evaluating or mutating the new revision. Other state and Todo mutations wait for active agent work to settle; V2 then reads an updated Todo list before continuing. Read-only commands remain immediate.

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
                         Todo → final answer → complete
                                      delivery failure → paused
```

The core agent marks a run inactive before dispatching `agent_settled`. V2 therefore treats an in-flight evaluator as busy even though the core context reports idle.

At `turn_start`, V2 records the active session/ID/revision, starts active-time accounting, and captures a progress fingerprint. At `turn_end`, it accounts the assistant message and detects budget, abort, or error. `agent_end` stores the full conversation for the settled check. At `agent_settled`, V2 evaluates only if the run is still active and the captured marker still matches.

## Prompt and Todo contract

V2 has no `before_agent_start` handler and does not mutate the system prompt. Its `context` handler removes stale V2 snapshots and inserts one hidden `kimchi_ferment_v2_context` message containing status, objective, token budget, and bounded durable lessons. The ordinary Todo extension injects current Todo state separately in the transient request context; neither injection becomes a permanent transcript message.

The active context tells the agent to:

- keep one visible tactical Todo list and leave it visible;
- add Todos when objective-required work is discovered;
- preserve settled Todos and their evidence when more work is found, extending the list or reopening the matching item;
- preserve compact `Decision:`, `Evidence:`, or `Dead-end:` notes for compaction;
- settle every Todo and map each objective requirement to current evidence before finishing; and
- communicate only task work, results, and blockers; give the concrete outcome and evidence when ready, otherwise state the next concrete need.

Todo writes use normal scope resolution. Omitted scope is auto-routed; agent workers use global scope. V2 accepts observations only from the currently resolved scope and binds them to the current session, V2 ID, and revision. A visible list is required for completion, and every item must be completed for the `complete` gate. An explicit `blocked` update is immediate.

Terminal Todo notes become at most five bounded durable lessons. Only lessons prefixed `Evidence:` are evaluator evidence; unprefixed completed notes are decisions, and blocked notes are dead ends.

`update_ferment_v2 complete` records an optional runtime-only completion claim and terminates the working turn; no standalone claim turn is required because a settled visible Todo list also makes text-only assistant output a completion candidate. Assistant prose is buffered while it streams and released at `message_end`: only a completion candidate stays hidden, so an unaccepted candidate never reaches TUI, print, JSON, ACP, or the working journal; an in-memory copy of it is available only to the evaluator. Ordinary current-revision tool-bearing work remains visible even when the preceding Todo snapshot was settled. The hidden message is marked as intentionally withheld so generic empty-turn and exploration guards cannot inject extra turns around evaluation. Thinking and already-running tool activity are not suppressed. After an edit, however, prose from the assistant message that began under the old revision remains hidden, and a Todo write emitted by that stale message is blocked before execution. The claim is not proof and is not required for a `met` evaluator result to complete a run; if present, its self-reported confidence is copied forward. A `met` verdict queues one final-answer turn and headless mode waits for it; tool calls are blocked and answer text is buffered during that turn, then released without outer whitespace after it settles. Interactive mode still requires a completed visible Todo list before delivery; headless mode has no visible Todo widget and may proceed directly from an evidenced `met` verdict. The run becomes `complete` and emits its completion event only after that turn delivers non-empty text without aborting or erroring; otherwise it becomes resumably `paused`. Restart and explicit resume recover an accepted-but-undelivered answer from the persisted `met` verdict and, in interactive mode, completed Todo state. If pause, edit, clear, or a Todo command mutation invalidates an already queued delivery, its hidden control message is removed from provider context; Todo mutation also clears the stale accepted evaluation before work resumes. `update_ferment_v2 blocked` persists immediately and records its reason.

## Settled evaluation

The evaluator uses the session model in single-model mode. With multi-model enabled, it resolves the first configured `judge` role and falls back to the session model if that lookup fails. It makes one tool-free `completeSimple` call with a 180-second default timeout (`fermentV2.evaluationTimeoutMs` is configurable), a reasoning-aware token limit, and provider JSON mode for Moonshot and Kimchi-managed evaluators. When PII redaction is enabled, the complete rendered evaluator prompt is redacted before it is recorded or sent; a redaction failure makes evaluation unavailable instead of sending raw input. When an interactive turn produced a hidden candidate, the evaluator runs inside the awaited `agent_end` hook and holds Kimchi's existing cooking animation for the call; every other turn evaluates at `agent_settled`, so automatic compaction between those hooks is never blocked. Each call is recorded as a child Pi session linked to the working session, so its prompt, response, model, activity, and usage stay out of the working journal.

Its input is the objective, bounded Todo state (8,000 characters), at most five lessons, and bounded transcript units (16,000 characters). Tool calls stay paired with linked results where possible; oversized non-evidence chatter is skipped so older linked results can remain, and thinking is removed. A `met` verdict is accepted only when every objective check is met, names a plausible failure mode, cites at least one retained authoritative item, and uses only known Todo IDs. Extra context citations do not invalidate an otherwise evidenced check. Todos remain a tactical completeness gate, but incidental settled Todos do not need artificial evaluator checks. Only linked tool results and `Evidence:` lessons receive citation IDs and count as authoritative evidence. Claims, plans, tool calls, file edits, decisions, dead ends, and exit status alone do not.

If the evaluator returns `continue` after the Todo list was settled, the continuation prompt tells the agent to preserve the settled Todos and their evidence, then extend the list with the concrete missing work or reopen the matching Todo. A check with no cited authoritative evidence explicitly asks for a proving check and an `Evidence:` Todo note. Evaluator reasons are passed through only when task-facing; protocol-framed reasons fall back to the first unmet requirement so internal evaluator language cannot leak into working turns or status output.

Verdicts have these effects:

- `continue`: persist the evaluation and queue one hidden `followUp` continuation while all gates still pass. A reason is included in the hidden checkpoint steer.
- `met`: in interactive mode, request the final answer only when the current revision has a non-empty visible Todo list whose items are all completed; headless mode may proceed without an invisible Todo list. Mark complete only after that answer is delivered successfully, otherwise pause.
- `impossible`: persist `blocked` with the evaluator reason.
- `unavailable`: persist the evaluation and pause. Missing model/authentication, timeout, cancellation, call failure, malformed output, and truncated output all fail closed after that single call.

## Gates and stop conditions

Evaluation and continuation require an active current revision, no pending user message or user mutation, all V2 and Todo tools, and a non-stale session context. A pending user message or mutation invalidates the verdict; a completed evaluator response remains accounted in its child session even when the verdict is discarded. Missing tools abandon evaluation and release a waiting headless command.

An aborted agent turn pauses immediately. Agent errors are counted once at the settled run boundary, not once per retry `turn_end`; three consecutive errors pause by default. Three stalled continuation checkpoints pause by default when the canonical fingerprint does not change and either no substantive active work ran or the same evaluator gap keeps repeating. Pending-only Todo additions and display-only reordering do not count as progress; starting or settling a Todo, revising its active fields, or adding durable lessons does. Substantive tool use normally resets the counter, but it cannot keep a run alive when both the objective fingerprint and evaluator gap remain unchanged.

Working-turn token usage is checkpointed at `turn_end`. If the run reaches its token budget, it becomes `budget_limited` and no evaluator or continuation is started for that turn. The already accepted final-answer delivery is excluded from this work budget; its usage remains in the normal session record. Active time is accumulated only while an active work turn is running; it is checkpointed on turn end and management mutations.

## Replay, restart, compaction, and headless runs

`session_start` and `session_tree` replay the selected session branch. Rewind and fork therefore select independent V2 histories. After compaction or branch navigation, V2 replays the latest state and Todo writes and rebuilds the context message. Durable Todo notes can remain available as lessons after terminal Todos leave the current list. Explicit `/ferment-v2 resume` restores the persisted guard counters only to reset them in its own commit; ordinary replay preserves them.

An active run schedules a deferred automatic resume only for an interactive UI session, after checking for busy state, pending messages, and unchanged ID/revision. If its last evaluation was `met` and its restored Todo list is complete, that kick delivers the final answer instead of resuming work. Headless `session_start` deliberately does not compete with the incoming prompt. Headless create, edit, and resume commands wait only when they successfully queue a turn; waiters resolve on terminal state, clear, replacement, or when a continuation cannot be queued (for example, tools are unavailable or synchronous context is stale).

Runtime-only state is rebuilt on replay; pending continuation, terminal-feedback, and queued/active final-answer markers are retained only when their same-session ID/revision still matches the replayed V2, and are otherwise discarded. Cross-session replay resets them, along with active/failed turn markers, completion claim, captured conversation, evaluator abort controller, active-time start, progress fingerprint, and in-memory Todo/lesson bindings. Accepted final-answer readiness is derived again from the persisted evaluation and Todo state. The journal persists the objective state, accounting, evaluations, and guard counters.

## Visibility, telemetry, and benchmark accounting

V2 control/context messages and the `get_ferment_v2`/`update_ferment_v2` tools are hidden from normal tool rendering and bypass permission prompts. Evaluation details are not emitted as visible transcript text. The existing working indicator remains active while an interactive completion candidate is evaluated, and prompt-summary display waits for true session idle so it cannot become an accidental model steer during a slow evaluation. `/ferment-v2` is the supported user-facing status surface; there is no dedicated V2 status-line segment.

The extension emits these lifecycle events: `ferment-v2:started`, `ferment-v2:replaced`, `ferment-v2:edited`, `ferment-v2:completed`, `ferment-v2:blocked`, `ferment-v2:paused`, `ferment-v2:stalled`, and `ferment-v2:evaluated`. Built-in telemetry subscribes only to `ferment-v2:evaluated` and records the V2 ID, verdict, count, evaluator model, token buckets, total tokens, and cost. It does not record the evaluator reason or objective, and unavailable evaluations do not emit an evaluated telemetry record.

V2 runtime accounting describes the working assistant turns and excludes accepted final-answer delivery from its work budget. Evaluator usage belongs to its child sessions. Both delivery and evaluator usage remain in their normal session records. The Terminal-Bench adapter recursively scans every discovered `sessions/**/*.jsonl`, sums valid assistant entries, and includes cache read/write in the input total, so working, evaluator, and other child sessions are counted once through the same path.

## Ferment V1 boundary

Ferment V1 remains the default-enabled, cross-session project mode. It persists JSON files under `.kimchi/ferments/`, tracks phases and steps, and owns workers, worktree metadata, and its own lifecycle runtime. See [docs/ferment.md](ferment.md) and [the V1 schema](ferment-storage-schema.md). Ferment V2 is a separate `extensions.ferment-v2` resource and does not migrate or replace V1 state.

## Implementation references

- [V2 extension](../src/extensions/ferment-v2/index.ts), [reducer](../src/extensions/ferment-v2/reducer.ts), [prompt](../src/extensions/ferment-v2/prompt.ts), [evaluator](../src/extensions/ferment-v2/evaluator.ts), and [types](../src/extensions/ferment-v2/types.ts)
- [V2 unit tests](../src/extensions/ferment-v2/index.test.ts) and [evaluator tests](../src/extensions/ferment-v2/evaluator.test.ts)
- [V2 TUI flow](../tests/e2e/tui/ferment-v2-mode.test.ts) and [headless smoke coverage](../tests/smoke/ferment-v2-print-exit.test.ts)
