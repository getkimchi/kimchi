# IDE Adapter Architecture

Internal documentation for Kimchi contributors working on the `ide-adapter` extension.

## Overview

The adapter discovers IDE plugins via filesystem lockfiles, opens a WebSocket MCP connection, proxies all IDE tools into the agent namespace, and handles two notification types: `at_mentioned` and `selection_changed`.

## Tool Call Behaviour

When the agent calls a proxied IDE tool (`ide_<name>`), the harness forwards it to the IDE and normalises the response:

| Scenario | Harness response |
|---|---|
| Success | `content: [{type: "text", text: "<JSON-stringified result>"}]`, `details: <raw result>` |
| IDE connection lost mid-call | `content: [{type: "text", text: "IDE connection lost"}]`, `details: {error: "IDE connection lost"}` |
| Tool throws | `content: [{type: "text", text: "IDE tool error: <message>"}]`, `details: {error: <message>}` |
| Call aborted (signal) | `content: [{type: "text", text: "Tool call aborted"}]`, `details: {error: "aborted"}` |

## Notification Handling

### `at_mentioned`

- **UI active** — the mention text is pasted into the editor immediately via `pasteToEditor`, and a status update is triggered so the text renders without waiting for the next keystroke.
- **UI not available** — the mention is queued. On the next user input, all queued mentions are prepended to the prompt text.
- **Queue cap**: `MAX_PENDING_MENTIONS = 100`. Oldest entries are dropped when exceeded.

### `selection_changed`

The harness renders the current IDE selection as a live input-box chip (`@file:range`) and auto-attaches it to the next prompt on send. The selection is **sticky** — it stays attached on every send until a new `selection_changed` overwrites it (unlike `at_mentioned`, which is drained on send). If the user explicitly at-mentions the same range they have selected, the selection prefix is suppressed to avoid duplication.

**Note:** the harness does not auto-clear the selection on its own — it relies on the plugin's next notification to overwrite it. The indicator is only explicitly cleared on `session_shutdown`.

## Lockfile Matching

1. Filter lockfiles to those whose `pid` is still alive (`kill(pid, 0)`).
2. Prefer a lockfile whose `workspaceFolders` contains the current working directory (exact match or nested path).
3. If no exact match exists, **fall back to the first alive lockfile**.

## Runtime Constants

| Constant | Value | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `5000` | How often the harness rescans for new lockfiles |
| `MAX_RECONNECT_RETRIES` | `3` | Failed connection attempts before the extension stops polling for that session |
| `DEFAULT_HANDSHAKE_TIMEOUT_MS` | `10000` | WebSocket `open` timeout |
| `MAX_PENDING_MENTIONS` | `100` | Max `at_mentioned` queue size |

## Detailed Lifecycle

```
IDE opens project
   └─> starts WebSocket server
   └─> writes lockfile

Kimchi starts or opens a new session
   └─> scans lockfile directory (every 5 s)
   └─> finds matching workspace folder (or first alive lockfile)
   └─> connects WebSocket (?token= query param)
   └─> MCP initialize / initialized handshake (10 s timeout)
   └─> calls tools/list
   └─> registers tools as ide_<name>

User selects code and clicks "Send to Kimchi"
   └─> IDE sends at_mentioned notification
   └─> harness pastes immediately if UI active, else queues
   └─> on next user input, any queued mentions are prepended as @file:range

IDE cursor/selection moves
   └─> IDE sends selection_changed notification (plugin-side ~150 ms debounce)
   └─> harness renders @file:range as an input-box indicator chip
   └─> harness stores selection as sticky _latestSelection

User submits a prompt
   └─> pi.on('input') prepends @file:range from _latestSelection (sticky, not consumed)
   └─> dedups against any explicitly queued at-mention of the same range

IDE closes project
   └─> deletes lockfile
   └─> WebSocket closes
   └─> harness onDisconnect fires immediately
   └─> harness nulls connection and will reconnect on next poll
```

## Design Notes

- **Generic, not IDE-specific** — the harness contains no JetBrains/VS Code/etc. logic. Everything is driven by the lockfile and MCP tool list.
- **Custom transport** — the WebSocket upgrade uses a query parameter (`token`). The harness implements its own lightweight transport on top of the `ws` package.
