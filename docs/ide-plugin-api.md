# IDE Plugin API Contract

This document defines the API contract between the Kimchi harness and external IDE plugins (IntelliJ IDEA, VS Code, Neovim, etc.). Any IDE plugin that follows this contract will be auto-discovered and connected by the Kimchi harness.

## Overview

1. The IDE plugin starts a **WebSocket server** bound to `127.0.0.1` on a random free port.
2. The plugin writes a **lockfile** to `~/.config/kimchi/ide/<port>.lock`.
3. The Kimchi harness scans this directory on startup, finds a matching lockfile, and connects via WebSocket.
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
| `transport` | string | no | Transport type; must be "ws" (default: "ws") |

The harness picks the lockfile whose `workspaceFolders` contains the current working directory. The lockfile is deleted automatically when the IDE closes.

## WebSocket Connection

Endpoint: `ws://127.0.0.1:<port>/mcp`

### Authentication

The harness sends the `authToken` in the `x-secret-key` header during the WebSocket upgrade handshake. The server must reject connections without this header.

### Protocol

JSON-RPC 2.0 over WebSocket, conforming to MCP 2024-11-05. Standard MCP initialization (`initialize`, `initialized`) must be completed before tool calls.

### Tools

The harness calls `tools/list` after initialization and registers every tool with the prefix `ide_`. For example, an IDE tool named `openFile` becomes `ide_openFile` in the agent.

### Example Tool Set

| Tool | Description |
|---|---|
| `openFile` | Open a file in the editor, optionally at a line/range |
| `openDiff` | Show a diff viewer; blocks until user accepts or rejects |
| `getCurrentSelection` | Return the active editor's selection |
| `getLatestSelection` | Return the most recent selection (even after focus change) |
| `getOpenEditors` | List open tabs |
| `getWorkspaceFolders` | Return project root paths |
| `getDiagnostics` | Return LSP/inspection errors |
| `checkDocumentDirty` | Return whether a file has unsaved changes |
| `saveDocument` | Save a file |
| `closeAllDiffTabs` | Close all diff tabs |
| `close_tab` | Close a specific tab |

## Notifications (IDE → Harness)

The IDE may send JSON-RPC **notifications** (no `id` field) over the WebSocket at any time.

### `at_mentioned`

Sent when the user selects code and clicks "Send to Kimchi". The harness prepends `@filePath:start-end` to the next user prompt.

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

### `selection_changed`

Sent when the cursor/selection moves (debounced ~150ms by the IDE).

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

Kimchi starts or opensnew session
   └─> scans lockfile directory
   └─> finds matching workspace folder
   └─> connects WebSocket (with x-secret-key)
   └─> MCP initialize / initialized handshake
   └─> calls tools/list
   └─> registers tools as ide_<name>

User selects code and clicks "Send to Kimchi"
   └─> IDE sends at_mentioned notification
   └─> harness queues mention
   └─> on next user input, prepends @file:line range

IDE closes project
   └─> deletes lockfile
   └─> harness disconnects on next poll
```

## Generic Design Notes

- **No JetBrains-specific logic** in the harness. Only generic lockfile, WebSocket MCP, and notification handling.
- Any IDE supporting the lockfile + WebSocket MCP protocol can integrate without harness changes.
- The harness uses the official `@modelcontextprotocol/sdk` WebSocket transport (custom wrapper for auth headers).
