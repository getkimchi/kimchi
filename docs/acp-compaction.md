# ACP compaction wire contract

How context compaction is driven, tracked, and reflected over the ACP wire —
the `_kimchi.dev/compact` and `_kimchi.dev/compact_abort` ext methods, the
`agent_activity` lifecycle notifications, and the post-compaction
`usage_update` refresh. Everything here rides ACP's standard channels plus the
`kimchi.dev` ext namespace; nothing is advertised in capabilities, so clients
that ignore the extensions see a working session that simply never surfaces
compaction progress.

## Driving compaction: `_kimchi.dev/compact`

ACP has no native client→agent compaction request (the upstream Session
Compaction RFD only covers agent→client status), so the affordance lives in
kimchi's own `_kimchi.dev` ext namespace — a vendor method of our own design,
shaped after what Zed asks external agents to expose (free-text instructions,
a force flag, a compaction-abort counterpart); Zed itself does not know this
method.

Request: `{ sessionId, instructions?, force? }`. `instructions` is free-text
guidance for the summary; `force` bypasses the token threshold (matching Zed's
native `/compact`), mapping one-to-one onto `AgentSession.compact(
customInstructions, force)`.

The method rejects with `invalid_params` when a prompt turn is active —
compact before or after a turn, never during it.

Response terminal statuses:

| status      | when                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `completed` | compaction committed; carries `summary`, `tokensBefore`, `firstKeptEntryId` |
| `cancelled` | `_kimchi.dev/compact_abort` fired; resolves (not errors) with the cancellation message |
| `failed`    | routine no-ops and expected failures ("Nothing to compact", "Already compacted", …) with the message in `error` |

Anything else propagates as a JSON-RPC internal error.

`_kimchi.dev/compact_abort` cancels a compaction in flight. It is safe to
call while the terminal notification is still in flight: the `cancelled`
response and the aborted `compaction_end` activity are ordered independently,
so clients should treat them as two views of the same outcome, not wait for
both.

## Lifecycle: `_kimchi.dev/agent_activity`

Compaction streams no transcript or session-update traffic by design — the
session's messages don't change until the summary commits. Progress rides the
`agent_activity` ext notification, forwarded verbatim from pi session events:

| `kind`                         | fires when                                    | notable fields |
| ------------------------------ | --------------------------------------------- | -------------- |
| `compaction_start`             | compaction begins                             | `reason`: `manual` \| `threshold` \| `overflow` |
| `compaction_end`               | compaction settles, any outcome               | `reason`, `result`, `aborted`, `willRetry`, `errorMessage?` |
| `summarization_retry_*`        | the summary LLM call is retried               | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` |

Outcome discrimination on `compaction_end`: **success ⇔ `result` is present**.
Every cancel (client abort, extension cancel) and every failure — including
overflow recovery exhausted after its one compact-and-retry attempt — carries
`result: undefined`. `errorMessage` is *not* a discriminator: aborted events
carry none either. `willRetry: true` can accompany a *successful* compaction;
it flags turn continuation after overflow recovery, not failure.

## Value refresh: `usage_update` after success

A successful compaction rebuilds the context, so the client's context-usage
gauge is stale the moment `compaction_end` lands — and `getContextUsage()`
reports `tokens: null` until an LLM responds *after* the new compaction
boundary (the pre-boundary usage would misreport the pre-compaction size).
Waiting for the next turn would leave the stale number up, reading as
"compaction did nothing."

So on **every successful compaction** — manual or automatic (`threshold`,
`overflow`), in-turn or out — the server emits a `session/update`:

```json
{
  "sessionUpdate": "usage_update",
  "used": 40000,
  "size": 200000
}
```

Semantics:

- **Value**: pi's own post-compaction estimate
  (`CompactionResult.estimatedTokensAfter`, a chars/4 heuristic over the
  summary plus kept entries — the same number pi's compaction threshold
  logic consumes). If a pi build ever omits the field, the server recomputes
  the identical fold over the rebuilt message list, so a success emits
  whenever the context window is known — and that guard is unreachable for a
  compaction that actually succeeded, since both pi compaction paths require
  a model. `used: 0` can only appear when the context is genuinely empty.
- **Precision**: the estimate overstates somewhat; the next assistant
  response's `message_end` emits the usual usage-anchored `usage_update`,
  which supersedes it (clients apply last-wins).
- **No `_meta`**: the `_meta` piggyback on turn-flow `usage_update`s carries
  cumulative turn usage; compaction may run with no turn at all, so this
  emission is bare.
- **Ordering**: the refresh lands after the `compaction_end` activity
  notification, so clients process lifecycle-end before the new count.
- **Silence on cancel/failure**: the context did not change, so nothing is
  emitted — the pre-compaction number remains correct.

## Where it lives

- Ext methods: `src/modes/acp/ext-methods/compact.ts`, `compact-abort.ts`
- Activity forwarding: `src/modes/acp/activity-updates.ts`
- Lifecycle + value refresh: `src/modes/acp/server.ts`
  (`onSessionEvent`, `emitPostCompactionUsage`)
- Unit tests: `src/modes/acp/server.test.ts`
  ("KimchiAcpAgent post-compaction usage_update"); e2e:
  `tests/e2e/acp/compaction.test.ts`
