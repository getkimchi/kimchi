# IDE Plugin Contract

This document defines the contract between the Kimchi harness and external IDE plugins (IntelliJ IDEA, VS Code, Neovim, etc.). Any IDE plugin that follows this contract will be auto-discovered and connected by the Kimchi harness.

## Overview

1. The IDE plugin starts a **WebSocket server** bound to `127.0.0.1` on a random free port.
2. The plugin writes a **lockfile** to `~/.config/kimchi/ide/<port>.lock`.
3. The Kimchi harness scans this directory, finds a matching lockfile, and connects via WebSocket.
4. The plugin exposes tools over the **Model Context Protocol (MCP)** and sends **notifications** to the harness.

## Lockfile Format

Path: `$XDG_CONFIG_HOME/kimchi/ide/<port>.lock` (`~/.config/kimchi/ide/` by default)

```json
{
  "port": 54321,
  "pid": 12345,
  "ideName": "IntelliJ IDEA",
  "ideVersion": "2024.1",
  "transport": "ws",
  "workspaceFolders": ["/path/to/project"],
  "authToken": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `port` | number | yes | WebSocket listen port |
| `pid` | number | yes | IDE process PID (used for liveness check) |
| `authToken` | string | yes | UUID used for WebSocket auth handshake |
| `workspaceFolders` | string[] | yes | Absolute paths of open projects |
| `ideName` | string | no | Human-readable IDE name (default: "unknown") |
| `ideVersion` | string | no | IDE version string (default: "unknown") |
| `transport` | string | no | Transport type; must be `"ws"` (default: `"ws"`) |

The lockfile must be deleted automatically when the IDE project closes so the harness disconnects cleanly.

## WebSocket Connection

Endpoint: `ws://127.0.0.1:<port>/mcp`

### Authentication

The harness appends the **`?token=<authToken>` query parameter** to the WebSocket URL during the upgrade handshake. The server must reject connections missing this credential.

### Protocol

JSON-RPC 2.0 over WebSocket, conforming to MCP 2024-11-05. Standard MCP initialization (`initialize`, `initialized`) must be completed before tool calls.

## Tools

The harness calls `tools/list` after initialization and registers **every** tool returned by the IDE under the prefix `ide_`. For example, an IDE tool named `openFile` becomes `ide_openFile` in the agent.

There is no hard-coded tool surface — the harness blindly proxies whatever the IDE exposes. This allows each IDE plugin to define its own tools without harness changes.

## Notifications (IDE → Harness)

Send JSON-RPC **notifications** (no `id` field) over the WebSocket. The harness only consumes `method` equal to `at_mentioned` or `selection_changed`.

### `at_mentioned`

Sent when the user selects code and clicks "Send to Kimchi".

```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/abs/path/to/file.ts",
    "lineStart": 42,
    "lineEnd": 58
  }
}
```

- `lineStart: 0` and `lineEnd: 0` mean "no range".
- The harness formats this as `@/abs/path/to/file.ts:42-58` (or `@/abs/path/to/file.ts` when there is no range).

### `selection_changed`

Sent when the cursor/selection moves. The IDE should debounce this (e.g. ~150 ms) to avoid flooding the channel.

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "filePath": "/abs/path/to/file.ts",
    "lineStart": 42,
    "lineEnd": 58
  }
}
```

## Environment Variables

| Variable | Description |
|---|---|
| `KIMCHI_IDE_LOCKFILE_DIR` | Override the default `~/.config/kimchi/ide/` directory. Useful for testing. |

## Lifecycle

```
IDE opens project
   └─> starts WebSocket server
   └─> writes lockfile

Kimchi discovers and connects
   └─> scans lockfile directory
   └─> matches workspace folder (or any alive lockfile)
   └─> connects WebSocket (x-secret-key + ?token=)
   └─> MCP initialize / initialized handshake
   └─> calls tools/list
   └─> registers tools as ide_<name>

User sends code to Kimchi
   └─> IDE sends at_mentioned notification

IDE closes project
   └─> deletes lockfile
   └─> WebSocket closes
```

## Design Notes

- **No IDE-specific logic** in the harness. Any IDE supporting the lockfile + WebSocket MCP protocol can integrate without harness changes.
- The harness uses a **custom WebSocket transport** (wrapping the `ws` package) because the official `@modelcontextprotocol/sdk` WebSocket transport does not support custom auth headers.
