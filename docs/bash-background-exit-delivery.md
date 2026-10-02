# Background bash: reliable unattended-exit delivery

Implementation record for the delivery/ownership/guidance fix planned in
`.kimchi/docs/bash-control-comparison/implementation-plan.md` (branch
`fix-make-max-thinking-better`, starting revision `c4fd2ebf`).

## The failure that motivated this change

An unattended background-process exit was notified via
`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` and the
handle was removed from the process registry **before** delivery. The
installed SDK routes a streaming follow-up into `agent.followUp`, and the
core loop drains that queue only after its inner tool/steering loop would
stop — so a model that keeps calling tools could stay unaware of the result
indefinitely (demonstrated against the installed loop by
`.kimchi/docs/bash-control-comparison/queue-probe.mjs`: the marker stayed
invisible through rounds 2–4 and appeared only after round 4's tool-free
stop; an aborted request left it queued forever). Cancellation/error could
terminate the run before consumption, and because the handle was already
removed, `bash_control` could not recover the output — its unknown-handle
text even asserted the result "was delivered".

## What changed

### Delivery channel: steering, not follow-ups

Unattended-exit notifications now use
`{ triggerTurn: true, deliverAs: "steer" }` (bash-control-extension.ts). The
installed core loop consumes steering at the top of the inner loop — after
tool results are pushed, before the next assistant response — so the
result reaches the **next provider request** while the model keeps calling
tools. An idle agent is still woken by `triggerTurn`. Completion
continuations remain follow-ups (they intentionally continue an
otherwise-stopping run).

Queue-order limits (unchanged by this fix): steering drains
one-at-a-time, so an exit notification queued behind another steer (e.g.
the concurrency advisory) arrives one turn later. This is exercised and
asserted by test; no immediate-priority promise is made.

### Terminal-delivery state (`terminal-delivery.ts`)

A new session-scoped module owns the delivery lifecycle of every terminal
outcome, stored on `BashSessionState.delivery` and shared by the extension
(the automatic channel) and the `bash_control` tool (the control channel):

```
available → claimed for one channel → queued/response prepared
          → conversation acknowledged → retired
```

- The collector snapshots the terminal payload and records it **before**
  removing the execution resources, so the outcome stays queryable and
  recoverable until an authoritative acknowledgement retires it.
- Each automatic message carries typed `details`
  (`{ deliveryId, sessionId, handles[] }`); `markQueued` runs synchronously
  before `pi.sendMessage` because an idle `triggerTurn` dispatch starts
  processing immediately.

### Acknowledgement seams (verified against installed pi-coding-agent 0.85.1 / pi-agent-core 0.85.1)

- **Automatic messages:** the core loop emits `message_start`/`message_end`
  for each injected steering message and pushes it into the run context
  immediately after; the idle `triggerTurn` dispatch (`_runAgentPrompt` →
  `runAgentLoop`) emits the same events for the trigger messages before
  the first assistant response. Either way, a matching `message_end` (by
  customType + session identity + deliveryId) is the earliest point at
  which the outcome is committed to the conversation the next provider
  request will see — that is the retirement event.
- **Tool-owned outcomes:** the `tool_result` extension event fires from
  `agent.afterToolCall` before the result message is appended to the run
  context; a consolidated `bash_control` result carrying `exitedHandles`
  is authoritative by construction.

### Ownership decision (smallest tested strategy)

- **Irreversible channel ownership after enqueueing.** Once the automatic
  channel has marked an outcome `queued`, an inspection reports a
  *pending* status line (with the handle identity) instead of duplicating
  the payload; the identified steering message delivers it. An outcome
  still `available` (never enqueued, or released after a cancelled run) is
  claimed by the control call and delivered through its tool result.
- **Recovery after abort:** kimchi's TUI (Escape → `clearAllQueues`) and
  ACP (`cancel` → `clearQueue`) drop queued steering on user abort. On a
  run terminating with `stopReason` `"aborted"`/`"error"`, the extension
  therefore releases queued automatic outcomes back to `available`, where a
  later explicit inspection recovers them; it also suppresses
  `triggerTurn` for later exits (the payload is appended to the
  conversation without waking the cancelled run) until the next
  `agent_start`.
- **No duplicate payloads:** if a recovered outcome was already delivered
  by a control result and the stale automatic message still arrives
  (possible when a programmatic abort kept the queue), the extension's
  `message_end` handler replaces it in place — via the SDK's
  message_end replacement hook, which mutates the message for both the
  run context and session persistence — with a short suppression note. The
  same mechanism makes acknowledgement idempotent for duplicate
  deliveries of one deliveryId.
- **Failed collection/call:** a synchronous collection failure releases
  the registry claim and restores tracking (retry possible); a control
  call that recorded an outcome but never delivered it (e.g. an error
  result) releases its claim from the `tool_execution_end` backstop and
  requeues the *recorded* payload — no re-collection, no retry loop.

### Truthful status and guidance

- `bash_control` checks pending terminal outcomes **before** deciding a
  cohort is empty or starting a wait: a wait with only pending results
  returns them immediately (collected outcomes as an exit response,
  queued ones as pending status) and starts no timer; a genuinely empty
  session answers `No background processes or pending results remain. No
  wait timer was started; this call does not sleep.` Details gained an
  optional `pendingHandles` field (existing consumers unaffected).
- Unknown-handle wording no longer asserts delivery: it states that no
  live process, pending exit result, or queued delivery is associated
  with the handle.
- The completion continuation counts live processes **and** undelivered
  terminal outcomes, but defers to an identified queued notification (the
  steering itself continues the run — no redundant reminder).
- Guidance corrections: `backgroundSuggestion()` now describes the ~2s
  initial handoff and turn-boundary exit delivery (was "~15s … reviews …
  arrive automatically"); `terminalResultText()` says "earlier results"
  (was "previous reviews"); the `bash_control` description documents the
  pending/empty wait behavior. `INITIAL_HANDOFF_SECONDS = 2`,
  `DEFAULT_WAIT_SECONDS = 300`, `MAX_WAIT_SECONDS = 600` are unchanged.

## Tests

- `src/extensions/bash-background/delivery-integration.test.ts` — the
  decisive regression against the **real installed agent loop**
  (pi-agent-core resolved through the SDK's dependency path, deterministic
  fake model streaming, a dispatch that mirrors installed
  `AgentSession.sendCustomMessage`):
  - the starvation regression (fails with the old `followUp` delivery —
    verified by temporarily reverting the channel),
  - abort + queue-drop + explicit inspection recovery with exactly-once
    payload,
  - steering queue order behind an earlier steer.
- `terminal-delivery.test.ts` — phase/claim/acknowledge/release state
  machine, including supersession and session identity.
- `bash-control-extension.test.ts` — steering + typed details, message_end
  acknowledgement (batch handles, foreign-session guard), suppression
  replacement, abort release + no-`triggerTurn` restart, `agent_start`
  re-arm, failed-call requeue.
- `bash-control-tool.test.ts` — pending sweep (queued status vs
  available claim), pending-only wait (no timer), unknown-handle wording,
  stop dedup against the sweep.
- TUI e2e (`tests/e2e/tui/bash-background-cohort.test.ts`) — new
  user-visible workflow: a command emits its unique terminal marker at
  exit (past the handoff), the model keeps doing independent read work,
  and the marker reaches the request after the turn in which the exit
  landed; first-request visibility + once-per-history presence asserted.

Verification run on this branch: `pnpm run check` clean; unit suite
12,104 passed; TUI e2e `bash-background-cohort` 5/5 and `bash-background`
2/2; ACP e2e 56/56; smoke 36 passed / 12 env-conditional skips.

## Known limitations

- **No proactive re-delivery of released outcomes.** An outcome released
  after an aborted run (dropped steer) is recovered by an explicit
  inspection or by the completion continuation directing the model to
  wait/stop; nothing re-enqueues it automatically. Re-enqueueing could
  duplicate the payload if the original message survived (the TUI/ACP drop
  it), and the SDK queue is not inspectable from extensions. This is the
  documented trade-off of the message_end-replacement strategy above.
- **Steering FIFO only.** Delivery is at the next turn boundary in queue
  order; a notification behind other steers waits its turn. No priority
  mechanism was added.
- `pi.sendMessage` returns `void`; asynchronous send failures are not
  observable to the extension. A permanently unacknowledged outcome stays
  pending (queryable/truthful status) rather than being silently retired.

## Benchmark status: OUTSTANDING

The post-fix benchmark comparison (same five-task × three-attempt
max/high matrix as p2873/p2874, same model/configuration and process
limits, handoff still 2s, revision/config metadata preserved) has **not**
been run — the benchmark runner/model were not available during this
implementation. Per-task/trial recording requirements (success/timeout,
rounds, token breakdowns, duration, call counts, empty/pending result
events, notification count, per-handle terminal disposition) are specified
in the implementation plan and remain to be produced. Handoff tuning and
steering-volume experiments remain subsequent work.
