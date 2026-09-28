# Subagent communication protocol

This describes the experimental implementation on `feat-agent-comms-imprv`, based on `9c06bed74a3a3ca9873b62433f09fb1e9672bcfb` with local changes, checked on 2026-09-21. The [overview](README.md) connects communication to delegation, TODOs and Ferment v2. The [write-up](communication.md#observed-results) separates working communication paths from measured work quality.

## Routing and identity

Workers send typed payloads through `AgentManager`. The host supplies the sender identity, root session, group and task reference. Workers select a recipient from `list_agent_contacts`; peer `agent_id` is the messaging identifier. Task IDs remain in host records and handoff evidence.

| Route | Behavior |
|---|---|
| Worker to peer | Same-root, same-group authorization. A running peer receives a steering message; a peer whose session is not ready can receive a queued message. Terminal peers are unavailable. |
| Worker to parent | The parent receives a notification identifying the source worker, task and message. |
| Worker to user | Questions go through the parent. The contact resolver uses an available autonomous Ferment judge, then an interactive questionnaire, otherwise reports the route unavailable. |
| Parent reply | `reply_to_agent_message` answers or declines an open question. A running worker receives a steer; a settled worker can resume with bounded turns, duration and tokens. |
| Parent correction | `steer_subagent` supplies an uncorrelated correction. `resume_subagent` continues a settled worker. Neither substitutes for answering an open question. |

Ferment v1's judge route is separate from Ferment v2's completion evaluator. Communication does not require either. Peer messages cannot grant permissions, change the worker's assignment or override the user's instructions. A worker reports a conflicting request to its parent.

## Message payloads

`send_agent_message` takes `recipient`, `payload` and, for a reply, `reply_to`. Recipient shapes are `{ "type": "parent" }`, `{ "type": "user" }` and `{ "type": "agent", "agentId": "…" }`.

| Kind | Recipients | Payload fields | Thread behavior |
|---|---|---|---|
| `question` | Parent, user or peer | `question`, `impact`, `canContinue`; optional `options`, `recommendedDefault` | Opens a question |
| `answer` | Peer | `answer`; optional `evidence` | Answers an open question |
| `decline` | Peer | Optional `reason` | Closes an open question without an answer |
| `status` | Parent or peer | `summary`; optional `nextAction` | One-way update |
| `handoff` | Parent or peer | `action`, `state`, `evidence`, `nextAction`; optional `result` | One-way handoff; host stamps `sourceTaskId` |

The child tool exposes a structural SDK schema, then applies the strict domain validator before routing. An answer or decline may put its explicit `reply_to` beside `payload` or inside it. The adapter moves a nested ID to the outer location. Different IDs in both locations fail without sending. New questions and updates cannot carry `reply_to`.

Validation remains local. In an isolated [provider-schema probe](schema-enforcement-evaluation.json), the tested glm-5.3-flash route returned an invalid mixed-field payload despite receiving `strict: true` and the unchanged tool schema. The SDK rejected it before execution.

Peer questions identify their sender and `message_id` in the delivered header. Reply to that sender using the question's ID. The host checks caller, recipient and scope before returning thread details. For a mistyped reply ID, it can return `openQuestionIds` limited to open questions from that recipient to that caller. It never selects, sends or closes a question automatically.

A reply envelope identifies the original question with `replying to <question-id>`. An observer checking delivery must match the sender, original question and payload; searching only for the reply's new message ID misses this path.

## Receipts and question lifetime

| Receipt | What it establishes |
|---|---|
| `queued_for_parent` | The parent-facing notification was accepted |
| `queued_before_session` | The payload is in pending storage |
| `queued_for_running_session` | The running session accepted the steer or queue operation |
| `resume_attempt_completed` | A bounded reply/resume attempt finished |
| `rejected`, `unavailable`, `saturated` | The operation failed; inspect its reason and available recovery details |

Child sends and parent replies throw failed receipts as JSON errors, so Pi records `isError: true`. Successful receipts return normally. Queue acceptance does not prove the recipient read the message, acted on it or produced correct work.

Questions acquire a thread when accepted for routing. Only the addressed recipient can reply. The first authorized answer or decline closes the thread; later replies get `thread_closed`. Peer threads also close when a participant finishes or aborts. A worker that must stop before receiving an answer can report the unresolved question to its parent. A decline means the recipient will not answer; the sender follows its declared independent-work plan or reports the blocker.

When the parent verifies a finished worker and completes its TODO through `reconcile_agent_result`, the host closes that worker's remaining nonblocking parent/user questions with reason `parent_verified_completion`. The result lists the closed question IDs. A late reply is rejected without resuming the worker. An open question with `canContinue: false` prevents reconciliation until it is answered or declined; a successful command alone cannot discard that blocker. Failed or stale verification leaves questions open. Closure records verified completion, not a fabricated answer.

Idempotency uses sender, attempt and tool-call identity. Replaying the same call returns its cached outcome. A separate loop guard rejects an identical new payload from the same sender to the same recipient within 120 seconds after an accepted delivery. Answers and declines use thread closure instead. Failed deliveries do not bind this duplicate-send guard. Its JSON comparison is key-order-sensitive.

## Group board

The host creates a board scope for eligible workers launched together with `communication: "group"`. Parent-only communication has no group board. The owning parent journals accepted entries as `agent-board:entry:v1` custom session records. Session start, reload and tree navigation recover the current branch's bounded view, preserving IDs, authors and timestamps while replacing superseded progress snapshots. Malformed entries and records from another root are ignored. The parent can read recovered groups without live worker records; saved authors gain no contact or messaging capability. Message threads and worker processes are not restored.

```text
post_agent_note { kind: note|work|finding|warning, title, body }
read_agent_board { since_id?, kind?, limit? }
```

A post records the host-stamped author, root session, group, ID and time. All authorized group members can read it. The post does not push its full body into every worker or prove that anyone acted on it. Directed messages serve a specific recipient; the board holds shared findings and references.

A successful post returns the entry and truncation information, or `deduped: true` with an existing entry. Identical normalized content from the same author and kind deduplicates for 120 seconds. Title and body remain separate key fields, so pipe characters do not merge distinct findings. A read returns `entries` and the board's `total`. Board rejection receipts use `ok: false` with `not_authorized_for_board` or `agent_not_live`. The tools throw the unchanged receipt JSON so Pi records `isError: true`. An authorized empty read remains successful.

### Reading new entries

Reads return entries in posting order, defaulting to 50 and capped at 200. `since_id` excludes the named entry and returns later entries; `kind` then filters that set. An unknown or evicted cursor starts from the retained entries.

Use the last entry actually read as the next cursor. A contact or context hint's `latestId` may identify an unread entry: passing it as `since_id` skips that entry. For example, if the hint announces `bd-new` and no entry has been read, `read_agent_board {}` includes it; `read_agent_board { since_id: "bd-new" }` asks only for entries after it. A kind-filtered read does not establish that entries of other kinds were read.

Manual posts cannot be edited or retracted. Corrections are new entries referencing the earlier finding. A posted claim remains unverified until the recipient checks its evidence.

Automatic TODO progress is a snapshot. The host derives a snapshot identity from the worker session and TODO scope; models cannot supply it through `post_agent_note`. A new snapshot removes the previous one from the same author and group and gets a new entry ID. Other scopes, authors and manual posts are retained. Dedupe metadata is removed with the old entry, so reopening an earlier state remains visible. Superseded cursors use the same fallback as other evicted cursors. Full TODO history stays in the worker journal; previous tool results already read by an agent are not rewritten.

### Discovery and parent progress

`WORKER_BOARD_PROMPT` is added only for workers with board tools. It asks workers to post findings affecting shared work, read relevant entries at dependencies and use directed messages for information a particular peer needs promptly. It does not impose a posting quota.

The worker `context` hook adds a transient hint containing the count and latest ID of deliberate posts by other workers in the group. `list_agent_contacts` returns the same metadata. Own posts and automatic TODO snapshots do not change that hint. A manual work note still qualifies. After an unfiltered successful read returns the latest peer post, the context hook removes its hint until a later peer post appears. Failed, kind-filtered or partial reads that miss the latest peer post leave the hint visible. This acknowledgment lives in the worker extension; a reload can show an already-read hint again. Explicit board reads and parent summaries still include all authors and automatic progress. Hints contain no entry bodies and are not saved in history.

The parent's `context` hook refreshes a transient `coordinator-board-state` digest before each model request. It lists up to three recent entries per nonempty group under the active root, with kind, author, title and ID. The digest requires active parent reply tools and labels entries as worker claims. It replaces its previous snapshot and disappears when communication is disabled or the root changes. It is neither displayed nor saved in session history. Board posts do not queue a parent follow-up or wake an idle parent; directed messages keep their existing delivery path. The parent can inspect artifacts or ask the author for details.

`subagents:board` events describe posts and evictions without bodies. Evictions identify the entry's own root and group, including global-cap eviction from another board.

## Bounds

The source constants are in [messages.ts](../../src/extensions/agents/messages.ts) and [board.ts](../../src/extensions/agents/manager/board.ts).

| Message limit | Value |
|---|---:|
| Payload | 16 KiB |
| Messages per attempt / pending messages per target | 32 / 32 |
| Open questions per agent / messages per thread | 8 / 16 |
| Receipts per agent / threads per agent | 64 / 16 |
| Global metadata records / pending payload bytes | 1,024 / 2 MiB |
| Handoff evidence references | 16 |
| Question options / characters per option | 8 / 256 |

| Board limit | Value |
|---|---:|
| Title / body | 120 / 2,048 characters |
| Entries per board / across all boards | 200 / 2,048 |
| Read default / maximum | 50 / 200 entries |
| Duplicate-content window | 120 seconds |

The tool schema rejects oversized post fields before routing. Direct host calls are truncated by the store. Board caps evict oldest entries. Message metadata reclamation preserves in-flight idempotency receipts. Neither board posts nor peer messages permit secrets, credentials, system prompts or private reasoning.

Each board operation rechecks worker status, group communication, visibility and the bound root. Terminal workers receive `agent_not_live`; disabled communication, system workers and callers outside the active group/root receive `not_authorized_for_board`. Rejected calls neither change board state nor emit board events. The [lifecycle checks](board-lifecycle-evaluation.json) cover retained capabilities and the authorized live workflow.

## Integration and checks

Final worker outcomes use the existing result/report path. The parent verifies work and can call `reconcile_agent_result` to connect the worker attempt and parent check to a TODO. Board posts do not complete TODOs. The [write-up](communication.md#from-worker-reports-to-task-progress) describes how checked progress reaches Ferment v2.

Focused source suites cover schemas, authorization, reply lifecycle, pending delivery, caps, deduplication, board reads, notifications and cleanup. The TUI scenario exercises board use through the built application. These checks establish feature behavior; the [observed results](communication.md#observed-results) assess the quality of work produced by agents.

```bash
pnpm exec vitest run src/extensions/agents
pnpm run typecheck
```

[Manager and broker](../../src/extensions/agents/manager/agent-manager.ts) · [Worker tools and context hint](../../src/extensions/agents/message-tool.ts) · [Parent notifications](../../src/extensions/agents/index.ts) · [Prompt construction](../../src/extensions/agents/prompt/prompts.ts) · [TUI scenario](../../tests/e2e/tui/agent-communication.test.ts)
