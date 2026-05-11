
# How the Claude Code JetBrains plugin actually works

The short version: **the JetBrains plugin is a wrapper that turns the IDE into an MCP server, and the Claude CLI in the terminal is the MCP client.** The "magic" is just a WebSocket on localhost plus a lockfile in your home directory that the CLI scans on startup. Once you understand that, building one is a normal IntelliJ Platform plugin.

Here's the architecture and the APIs involved.

## The protocol layer (this is the same regardless of editor)

The JetBrains, VS Code, and the third-party Neovim/Emacs/Nova ports all speak the same wire protocol — the JetBrains plugin has no privileged channel. The Neovim author reverse-engineered it and published [PROTOCOL.md](https://github.com/coder/claudecode.nvim) which is now the de-facto reference. The pieces:

**1. WebSocket server bound to 127.0.0.1.** The IDE picks a random free port (typically in the 10000–65535 range) and listens. Localhost-only — never bind to 0.0.0.0.

**2. Lockfile for discovery.** The IDE writes `~/.claude/ide/<port>.lock` (honoring `$CLAUDE_CONFIG_DIR` if set) containing JSON like:

```json
{
  "port": 12345,
  "authToken": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "ideName": "IntelliJ IDEA",
  "ideVersion": "2024.3",
  "transport": "ws",
  "workspaceFolders": ["/Users/you/project"],
  "pid": 54321
}
```

The Claude CLI scans this directory on startup (and on `/ide`), picks the lockfile whose `workspaceFolders` matches its cwd, and connects. There's a known JetBrains beta bug where the plugin shipped `LockFileUtil.class` but never invoked it — that's exactly the symptom of "Install the plugin" appearing even though it's installed.

**3. Auth.** The CLI sends the `authToken` in the `x-claude-code-ide-authorization` header on the WebSocket upgrade. The server rejects upgrades without it (HTTP 400). The Claude CLI also reads `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR` and `CLAUDE_CODE_SSE_PORT` env vars when the plugin spawns the terminal itself, so the terminal connects without typing `/ide`.

**4. Transport.** JSON-RPC 2.0 over WebSocket frames, conforming to MCP 2024-11-05. Internally Anthropic calls this protocol variant `ws-ide` (and `sse-ide` for the SSE flavor) — it's standard MCP plus the `ideName`/`ideVersion` identification fields.

**5. The MCP toolset the IDE exposes** (this is what makes it an "IDE integration" rather than just an LLM):

| Tool | What it does |
|---|---|
| `openFile` | Open a file in the editor, optionally jump to a line/range |
| `openDiff` | Show a diff in the IDE's native diff viewer; **blocks** until the user clicks Accept or Reject. Returns `userEdited: true` + `finalContent` if the user edited the proposal before accepting |
| `getCurrentSelection` | Active editor's selection with file path and range |
| `getLatestSelection` | Most recent selection (even after focus change) |
| `getOpenEditors` | List of open tabs with metadata |
| `getWorkspaceFolders` | Project root paths |
| `getDiagnostics` | LSP/inspection errors from the IDE |
| `checkDocumentDirty` | Has unsaved changes? |
| `saveDocument` | Save a file |
| `closeAllDiffTabs` | Cleanup |
| `close_tab` | Close a tab |
| `executeCode` | Run a Jupyter cell (only meaningful where notebooks exist) |

Plus IDE → CLI **notifications** (no response expected): `selection_changed` (debounced ~150ms) and `at_mentioned` for the "Send to Claude" feature you described — that's literally a JSON-RPC notification with `filePath`, `lineStart`, `lineEnd`, which Claude renders in the terminal as `@path/file:42-58`.

## What "Send to Claude" actually does

Your specific question: when you select code and click Send to Claude, the plugin emits a JSON-RPC notification over the WebSocket like:

```json
{
  "jsonrpc": "2.0",
  "method": "at_mentioned",
  "params": {
    "filePath": "/abs/path/to/Foo.kt",
    "lineStart": 42,
    "lineEnd": 58
  }
}
```

The CLI inserts a `@/abs/path/to/Foo.kt:42-58` reference into the prompt buffer. When Claude later wants the content, it calls its built-in `Read` tool with that path and line range — it doesn't need a separate "send the bytes" step, because the file is on disk and Claude can read any path. The plugin auto-saves the buffer first if it's dirty so the disk state matches what you see.

## The JetBrains side — actual IntelliJ Platform APIs

Building this as an IntelliJ plugin is mostly plumbing the WebSocket server to the Platform's read-model APIs. The relevant ones:

**Plugin scaffolding** — `intellij-platform-gradle-plugin`, `plugin.xml` declaring extensions, a `ProjectActivity` (replacement for the deprecated `StartupActivity`) to start the WebSocket server when a project opens, and a `Disposable` to tear it down.

**WebSocket server** — IntelliJ ships Netty bundled (`io.netty:netty-all`). You can use it directly or pull in Java-WebSocket / Ktor. The server lives in the plugin process, not a subprocess (unlike the Nova port, which is forced to spawn a Node child because Nova's JS runtime has no socket APIs — JVM has no such limitation).

**Editor and selection state** —
- `FileEditorManager.getInstance(project)` → `getSelectedEditor()`, `getOpenFiles()`, `getSelectedTextEditor()`
- `Editor.getSelectionModel()` → `getSelectionStart()`, `getSelectionEnd()`, plus `Document.getLineNumber(offset)` to convert offsets to 1-based lines for the protocol
- `SelectionListener` registered via `EditorFactory.getInstance().getEventMulticaster().addSelectionListener(...)` to drive the debounced `selection_changed` notifications
- `FileEditorManagerListener` on the project message bus for tab open/close/switch events

**Diff viewer (the killer feature)** — `com.intellij.diff.DiffManager.getInstance().showDiff(project, request)` with a `SimpleDiffRequest` built from two `DiffContent` objects (one from `DiffContentFactory.create(project, virtualFile)` for the original, one from `DiffContentFactory.create(newContent, fileType)` for the proposal). Mark it as editable on the right side so the user can tweak Claude's diff before accepting. To get the blocking accept/reject behavior the protocol expects, wrap the diff window in a modal dialog or use a `MergeRequest` with explicit Apply/Cancel actions, and resolve the JSON-RPC response from the action's callback.

**Diagnostics** — `DaemonCodeAnalyzerImpl.getHighlights(document, severity, project)` or iterate `MarkupModel.getAllHighlighters()` and filter by `HighlightInfo`. This gets you inspection results, syntax errors, and LSP diagnostics in the same shape.

**File operations** — Always use `VirtualFile` (not raw `java.io.File`). Reads/writes wrapped in `ReadAction.compute { }` / `WriteCommandAction.runWriteCommandAction(project) { }`. Saving is `FileDocumentManager.getInstance().saveDocument(document)`.

**Terminal integration** — the plugin uses the Terminal plugin's API to spawn `claude` as a child of the integrated terminal with the env vars set, so `/ide` is never needed: `org.jetbrains.plugins.terminal.TerminalToolWindowManager.getInstance(project).createLocalShellWidget(...)` (the API name has shifted across IDE versions, so check `TerminalView` / `TerminalToolWindowManager` for your target).

**Settings** — `Configurable` extension point for the Settings → Tools → Claude Code panel, with `PersistentStateComponent` for the `claudeCommand` path, port range, etc.

## How to build this — concrete starting points

If you want to build a similar integration (or understand the JetBrains one), the **best reference repos** are:

1. **[coder/claudecode.nvim](https://github.com/coder/claudecode.nvim)** — pure-Lua reverse-engineered implementation with a documented `PROTOCOL.md`. This is the canonical source for the wire format.
2. **[okapi-ca/claudecode-nova](https://github.com/okapi-ca/claudecode-nova)** — Nova editor port. The README has the cleanest end-to-end architecture diagram and the lockfile/handshake details. It even documents a real handshake bug they had: a transposed `Sec-WebSocket-Accept` magic GUID that broke against `ws`-based clients (worth knowing if you're rolling your own WebSocket).
3. **[manzaltu/claude-code-ide.el](https://github.com/manzaltu/claude-code-ide.el)** — Emacs port, useful for the per-project session model.

The minimum viable JetBrains plugin is roughly:

1. `ProjectActivity` starts a Netty WebSocket server on a random localhost port
2. Generate a UUID auth token, write `~/.claude/ide/<port>.lock`
3. On WebSocket upgrade, validate the `x-claude-code-ide-authorization` header
4. Implement MCP `initialize`, `tools/list`, `tools/call` over JSON-RPC 2.0
5. Wire `tools/call` for `openFile`/`openDiff`/`getCurrentSelection`/etc. to the IntelliJ APIs above, all marshaled onto the EDT via `ApplicationManager.getApplication().invokeLater`
6. Hook `SelectionListener` to push `selection_changed` notifications
7. Add an action with `EditorActionHandler` for "Send to Claude" that emits `at_mentioned`
8. `Disposable` cleanup deletes the lockfile on project close

One gotcha worth flagging: the `openDiff` response is **synchronous from Claude's perspective** — the model is blocked waiting for accept/reject. If you don't gate the JSON-RPC response on the user's click, Claude will think the edit was applied and continue, which leads to badly desynced state. The Neovim port uses Lua coroutines for this; on JVM you'd use a `CompletableFuture` resolved from the Apply action.

Want me to sketch out the Gradle/`plugin.xml` scaffold or zoom in on any specific piece (the diff blocking, the WebSocket handshake, the at-mention wire format)?