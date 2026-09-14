# agent-colab

Live session-to-session collaboration between running kimchi TUI sessions. Sessions
discover each other automatically, bind an A2A-compatible loopback inbox, and can hand
bounded work to a peer — "kinda like a subagent", except the worker is a full
interactive session with its own user, context, and TUI.

Enabled by default in TUI sessions. Disable with `AGENT_COLAB=off`.

## Commands

| Command | What it does |
|---|---|
| `/colab` | Pick a live session → link it as a worker, optionally tell your agent |
| `/agent-name <name>` | Name this session so peers can address it (persisted across restarts) |

## Tools

| Tool | Behavior |
|---|---|
| `list_peers` | Live local sessions (self hidden, linked marked) |
| `link_peer` / `unlink_peer` | Designate / drop a worker |
| `ask_peer` | Blocking task → wakes an idle peer, returns its reply as the tool result |
| `message_peer` | Fire-and-forget → never wakes the peer; optional `notifyWhenIdle` one-shot notice |

## Delivery semantics

Acknowledgment is transport-level, never model-level — the JSON-RPC task state is the
receipt, handled by this extension. The receiving agent never burns a turn to
acknowledge.

- **Fire-and-forget** (`message_peer`): task completes at injection. The message is
  integrated append-only as a small labeled plain-text block (`[peer message from …]`) —
  queued for the agent's next turn when idle (`nextTurn`, no turn started), or between
  tool calls when busy (`steer`).
- **Blocking ask** (`ask_peer`): an idle receiving agent is woken (`followUp` +
  triggerTurn); its next settled text reply is captured from the session file and
  returned to the sender as the task result.
- **Notices** (`notifyWhenIdle`): one-shot, sent by the extension — immediately if the
  peer is already idle, otherwise after its next settle.

Peers exchange conclusions + file pointers, never transcripts or JSON dumps. Inbound
messages append at the conversation tail, so every session remains a single
prefix-cache-friendly token stream. (Session merging is deliberately not supported: a
merged file is a token stream no inference server has cached. Use `kimchi -r` to move a
whole conversation.)

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_COLAB` | on | `off` disables the extension |
| `AGENT_COLAB_INBOUND` | `accept` | `hold` = approval dialog per message · `refuse` = reject at the door |
| `AGENT_COLAB_STATE_DIR` | `<agentDir>/peers` | peer registry location |

## Security

- Inboxes bind 127.0.0.1 only, with a mandatory per-session bearer token.
- Peer messages cannot approve permissions, change configuration, or execute commands;
  the receiver's own permission gates still apply.
- Every inbound message is labeled with its sender in the transcript.
- Abuse resistance: 200 KB message cap, burst cap, duplicate suppression, in-flight cap,
  self-send refusal — agent-to-agent loops die on their own.

## Implementation notes

- Each TUI session binds `GET /.well-known/agent-card.json` + `message/send`,
  `tasks/get`, `tasks/cancel` (JSON-RPC 2.0 over loopback HTTP — an A2A v1.0 subset;
  `client.ts`/`a2a-server.ts` is shaped for a later swap to the official `a2a-js` SDK).
- Peer registry lives at `<agentDir>/peers/` (`<sessionId>.json` records, pruned by pid
  liveness on read; `names.json` persists `/agent-name`). The agent dir is inferred from
  the live session-file path so all sessions converge on one registry.
- New/late/reloaded peers need no registration step: the registry is read fresh on every
  `list_peers` and `/colab`. Linked workers survive peer restarts — links re-attach by
  persisted name at the next agent turn.
- A standalone pi-package build of this extension lives at
  `getkimchi/pi-agent-colab` for vanilla-pi users.

## Tests

`pnpm vitest run src/extensions/agent-colab` — 37 tests covering the registry (liveness,
pruning, persistent naming), the A2A protocol (auth, caps, task lifecycle, real-socket
round-trip), the tools, and the full extension lifecycle on a mock harness (delivery
modes, consent, reply capture, idle notices, naming).
