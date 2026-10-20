# ACP response rating (`_kimchi.dev/feedback`)

The ACP counterpart of the TUI's response rating dialog: after a response
settles, the client submits exactly one rating — a sentiment plus an optional
reason — recorded as a custom transcript entry and telemetry. Ratings never
enter the model's context.

Vocabulary: a **rating** is the user's verdict (`positive`/`negative` plus an
optional reason) on the **settled response** (assistant response whose full
run chain — retries, queued follow-ups, compaction — has drained). A
**predefined reason** is picked from the fixed vocabulary; a **custom reason**
is typed (max 300 chars). The **rating window** is the interval in which a
rating may be submitted: it arms when a response settles, is consumed by
exactly one accepted submission, and clears on the next turn start or a
session reset.

## The contract

A single session-scoped inbound ext_method, action-discriminated, advertised
in `initialize` under `_meta["kimchi.dev"].feedback`:

```json
{
  "method": "_kimchi.dev/feedback",
  "params": {
    "sessionId": "…",
    "action": "rate_response",
    "sentiment": "positive",
    "reason": "Solved my task"
  }
}
```

Response on success:

```json
{ "status": "recorded" }
```

- `sentiment` (required) — `"positive"` or `"negative"`.
- `reason` (optional) — one string: a **predefined reason** label or the
  user's typed **custom reason**. The TUI's dialog treats them as two slots
  of the same list entry ("Type your own answer" selects the editor), so an
  ACP client that renders a "Why?" dropdown plus an "Anything else?" box
  merges them into the one string the API accepts. Empty string is a
  deliberate "no reason" submission. Anything past 300 characters is clamped
  server-side to the same cap the TUI applies, so transcript and telemetry
  agree.

## When a rating is valid — the rating window

The server keeps one rating window per session, armed when a response's
`prompt()` resolves `end_turn`. Exactly one accepted submission consumes it.
The window clears without recording when:

- the next turn starts (`turn_start`),
- the turn is cancelled or ends in a terminal error — **only `end_turn`
  settles rate**; a turn you saw fail or cancel has nothing rateable on the
  wire,
- the session resets or closes.

Invalid submissions fail with distinct errors:

| Situation | Code | Message |
| --- | --- | --- |
| A prompt is in progress for the session | `-32600` (invalidRequest) | `a prompt is already in progress for this session` |
| No window armed (nothing settled yet, already consumed, cancelled/errored turn, window cleared) | `-32600` (invalidRequest) | `no settled response to rate` |
| Bad params (missing `sessionId`, unknown action, sentiment outside the enum, non-string `reason`, unknown session) | `-32602` (invalidParams) | describes the param |
| The transcript write fails (disk full, session mid-teardown) | `-32603` (internal) | `failed to record rating: <detail>` — **nothing was recorded**; the window stays armed, so a retry is safe and cannot double-record |

## Reason vocabulary

Every settled response is rateable **regardless of which model ran the turn**
— Auto (routed virtual), or a concrete model. The model only changes what is
collected alongside the sentiment:

- The Auto-specific predefined entries below appear only for Auto turns;
- on non-Auto turns the telemetry's `routingModelId` is simply absent
  (`autoModelUsed: false`, no routed pick to report).

The TUI's predefined lists live in
[`src/extensions/feedback/dialog.ts`](../src/extensions/feedback/dialog.ts)
(`POSITIVE_REASONS` / `NEGATIVE_REASONS`). Clients that want a dropdown
parity with the TUI mirror these strings; the Auto-specific entries
("Auto picked the right model" / "Auto picked the wrong model") are shown
**only when the settled turn ran on the Auto model** — the client knows its
selected model (and receives `_kimchi.dev/routed_model` change events) and
owns this gating; the server never substitutes its reading of the turn for
the client's UI, though it always records its own settled-turn facts.

Telemetry tags each submission `predefined` vs `freeform` by matching the
reason against these lists, so typed text (which may contain paths or
pasted code) can be filtered downstream. Do not append prose to a predefined
label if you want that tag to stay `predefined`.

## What the server records, trust boundaries

Every accepted submission writes:

1. a `feedback-summary` custom transcript entry
   (`{ sentiment, reason }`) — persisted in the session log, never sent to
   the model; on the TUI side it renders as a "thanks, feedback received"
   card, so a consumer opening the session in the TUI sees ACP-submitted
   ratings seamlessly, and
2. a `trackFeedback` telemetry call whose `routingModelId` is computed
   **server-side** from the settled turn's routed pick (e.g. `auto-beta` →
   `glm-5.3`) — never accepted from client input.

`reason` text is user input: it is logged and sent to telemetry, and clamped
at the same 300-character boundary on both channels.

## Scope

- Rating only. Model-switch feedback (the TUI's "why did you switch off the
  Auto model" dialog) stays TUI-only; the action discriminator leaves room
  for a `model_switch` action later without a wire break.
- Subagent sessions carry no rating invitations — subagents are already a
  feedback signal of their own.
- Restored sessions (`session/load`) arm no window until a fresh turn
  settles; windows are in-memory by design.
