# ACP side chat (`/btw`)

Wire protocol doc: how an ACP client (Kimchi Studio, an IDE split view) drives
the experimental side chat from [feat-side-chat-cursor]. ACP has no split view,
so the client renders the pane; the Kimchi ACP server owns the side-chat
sub-session (branched from the main session, read-only tools), its transcript
persistence, and the wrap-up → send-to-main flow.

The feature is resource-gated: `extensions.side-chat` (Experimental, default
off, restart required) must be on, the same gate the TUI uses. With the
resource off, every method fails with `-32600` naming the resource.

## Capability advertisement

All methods are advertised under `_meta["kimchi.dev"]` in `initialize` /
`session/new` responses:

```
side_chat_open, side_chat_prompt, side_chat_wrap, side_chat_send_to_main,
side_chat_close, side_chat_history, side_chat_resume
```

The `side_chat_update` ext-notification is **not** advertised
(`queue_dropped` precedent): unaware clients ignore unknown notifications per
JSON-RPC rules.

## Inbound ext-methods (session-scoped, routed by `sessionId`)

### `_kimchi.dev/side_chat_open`

```jsonc
// params
{ "sessionId": "…", "question?": "…", "fresh?": true, "quote?": "…" }
// result — the side-chat snapshot
{ "id", "title", "fresh": false, "contextLength": 7, "mode": "chat", "thread": [], "closed": false }
```

Opens the pane: by default the side session inherits the main session's
context at the branch point (`contextLength` counts inrehited messages);
`fresh: true` starts without it. `question` asks immediately, `quote` seeds
the client input with a quoted main-transcript selection. Calling it on an
already-open chat returns its current snapshot (no replacement unless `fresh`
or `resume` say otherwise).

### `_kimchi.dev/side_chat_prompt`

```jsonc
{ "sessionId": "…", "text": "question" }  // text must not start with "/"
// result
{ "status": "started" /* or "queued" when a reply is still streaming */ }
```

The answer streams as `side_chat_update` notifications (`assistant_delta`
carries cumulative text). Rejects with `-32600` when no side chat is open.

### `_kimchi.dev/side_chat_wrap`

```jsonc
{ "sessionId": "…", "extra?": "keep it short" }
// result
{ "draft": "…" }  // "" when aborted or there was nothing to wrap
```

Drafts a steering message from the side thread (a separate tool-less session,
as the TUI's `/wrap`). The chat is left awaiting send or continued chatting —
the client owns the review UI: edit the draft, then call
`side_chat_send_to_main`.

### `_kimchi.dev/side_chat_send_to_main`

```jsonc
{ "sessionId": "…", "text": "final draft" }
// result {}
```

Steers the main session while its turn runs, plain-injects when idle; the
side chat closes with outcome `"sent"`.

### `_kimchi.dev/side_chat_close`

```jsonc
{ "sessionId": "…" }  // result {}
```

Discards the side chat (outcome `"closed"`), like the TUI header's ✕.

### `_kimchi.dev/side_chat_history`

```jsonc
{ "sessionId": "…" }
// result
{ "chats": [{ "id", "title", "label", "questions", "fresh", "outcome", "startedAt", "updatedAt" }] }
```

This session's side chats, newest first. `label` is the TUI picker row
("`14:32  retry policy  (2 questions · sent to main)`"), provided so clients
can render a consistent list.

### `_kimchi.dev/side_chat_resume`

```jsonc
{ "sessionId": "…", "sideChatId": "…" }
// result — the snapshot, same shape as open
```

Reopens a side chat from history; its stored thread is present in the
snapshot (and replays to subscribers).

## Outbound: `_kimchi.dev/side_chat_update`

```
{ "sessionId", "sideChatId", "update": { "type": …, … } }
```

Update types:

| type | payload | when |
|---|---|---|
| `opened` | `{snapshot}` | a chat opens; **also the first update every subscriber receives** (replay of the accumulated state) |
| `user_message` | `{text}` | a question lands in the side thread |
| `assistant_delta` | `{text}` | streaming; cumulative text — replace the buffer |
| `assistant_message` | `{text, stopReason?}` | the reply settled |
| `notice` | `{text, transient?}` | origin lines, resume notes, empty-status clears (transient) |
| `error` | `{text}` | the side turn failed or was aborted mid-stream |
| `working` | `{working}` | side agent busy / wrap drafting |
| `titled` | `{title}` | the first question named the chat |
| `wrap_draft` | `{text, final}` | `/wrap` stream; `final: true` marks the reviewable draft |
| `closed` | `{outcome?: "sent" \| "closed"}` | the chat ended; also replayed to subscribers joining after close |

Clients that connect (or open the pane) after the chat started subscribe and
get one `opened` snapshot carrying the thread so far — no separate
get-transcript method.

## The `/btw` slash command over ACP

The `/btw` command also works in ACP sessions (it appears in the
available-commands palette): `/btw <question>`, `/btw new <question>`,
`/btw close`; `/btw history` answers with a plain-text list (no picker over
ACP). Rich flows (resume, wrap review) go through the ext-methods above.

## Implementation map

- `src/extensions/side-chat/controller.ts` — surface-agnostic lifecycle
  (sessions, persistence, wrap, send-to-main) behind a `SideChatSink`.
- `src/extensions/side-chat/acp-bridge.ts` — sink → update payloads + snapshot
  replay; one `SideChatAcpBridge` per ACP session.
- `src/extensions/side-chat/registry.ts` — sessionId → bridge handoff for the
  ACP process.
- `src/modes/acp/ext-methods/side-chat.ts` — the handlers above; wire names in
  `src/modes/acp/capabilities.ts`; forwarding wired in
  `src/modes/acp/server.ts` via `emitExtNotification`.
