# DAP Debugger Extension

The DAP (Debug Adapter Protocol) extension gives the agent runtime debugger access via DAP. It is modeled on the existing LSP extension (`extensions/lsp.ts`) and follows the same patterns: adapter detection on `session_start`, status footer, tool registration, and teardown on `session_shutdown`.

## Architecture Overview

```
dap.ts (extension entry point)
├── adapters.ts        — adapter registry (configs, detection, root markers)
├── client.ts          — DAP wire protocol client (TCP + stdio transports)
│   ├── DapClientRegistry  — per-extension-instance client management
│   ├── sendRequest()      — DAP request/response correlation
│   └── startMessageReader() — async event pump (stopped/terminated/output)
├── session.ts         — DapSession (breakpoints, stepping, inspection)
│   └── DapSessionRegistry — per-extension-instance session management
├── composed.ts        — Layer 2 composed tools (debug_state_at, etc.)
├── tools.ts           — Layer 1 primitive tools + Layer 2 registration
└── types.ts           — DAP protocol types (DapClient, DapCapabilities, etc.)
```

### Key Design Decisions

1. **Per-extension-instance registries** — `DapClientRegistry` and `DapSessionRegistry` are instantiated in `dap.ts` closure scope (not module-level), so two extension activations in the same process don't share state.

2. **Fire-and-forget launch** — `session.launch()` sends the `launch` request without awaiting the response. Some adapters (js-debug, debugpy) defer the launch response until after `configurationDone`. `completeLaunch()` sends `configurationDone` and awaits both responses.

3. **TCP transport** — Both dlv and js-debug use TCP (not stdio). `client.ts` spawns the adapter process, reads the "listening at" line from stdout, and connects a TCP socket. The socket is wrapped as a `BunProcess` so the same reader/writer code works for both transports.

4. **js-debug nested sessions** — js-debug's `pwa-node` launch type sends a `startDebugging` reverse-request to spawn a child debug session. The client opens a new TCP connection to the same server, runs `initialize` + `launch` + `configurationDone` on the child, and routes all subsequent debug traffic to it via `client.childClient`.

## Supported Adapters

| Adapter | Language(s) | Transport | Binary Detection |
|---------|-------------|-----------|-------------------|
| dlv | Go | TCP | `which dlv` |
| js-debug | TypeScript, JavaScript | TCP | `which js-debug-adapter` |
| debugpy | Python | stdio | `python3 -c "import debugpy"` |
| lldb-dap | C, C++, Rust, Swift | stdio | `which lldb-dap` |
| java-debug | Java, Kotlin | stdio | `which java-debug` |
| rdbg | Ruby | stdio | `which rdbg` |
| php-debug-adapter | PHP | stdio | `which php-debug-adapter` |

## Adapter Config Format

Each adapter is defined in the `ADAPTERS` array in `adapters.ts`:

```typescript
{
    name: "dlv",
    command: "dlv",
    args: ["dap"],
    detectBinary: "dlv",          // optional: what `which` checks (defaults to command)
    detectModule: ["python3", "-c", "import debugpy"],  // optional: module-presence check
    transport: { kind: "tcp", portArgIndex: -1 },  // or { kind: "stdio" }
    languages: ["go"],
    extensions: ["go"],
    launchType: "go",             // DAP `type` field in launch request
    launchConfig: { mode: "debug" },  // optional: extra launch arguments
    installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
}
```

### Root Markers

Project-root markers signal which adapters are relevant to the current project:

```typescript
const ROOT_MARKERS: Record<string, string[]> = {
    dlv: ["go.mod"],
    "js-debug": ["package.json", "tsconfig.json"],
    debugpy: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    "lldb-dap": ["Cargo.toml", "CMakeLists.txt", "Makefile", "Package.swift"],
    "java-debug": ["pom.xml", "build.gradle", "build.gradle.kts"],
    rdbg: ["Gemfile", "Rakefile"],
    "php-debug-adapter": ["composer.json"],
}
```

### How to Add a New Adapter

1. Add a config object to the `ADAPTERS` array in `adapters.ts`
2. Add root markers to `ROOT_MARKERS`
3. If the adapter uses a module (not a standalone binary), use `detectModule` instead of `detectBinary`
4. If the adapter uses TCP transport, set `transport: { kind: "tcp", portArgIndex: N }` and ensure `client.ts`'s `spawnTcpAdapterForConfig` can parse the listening port
5. Add a language-specific skill constant in `dap.ts` (e.g., `DAP_JAVA_SKILL`) following the pattern of existing skills
6. Register the skill with on-demand injection: add a `xxxSkillActive` flag, register a system prompt block, and update the `tool_call` handler to set the flag
7. Update `adapters.test.ts` to include the new adapter in test assertions
8. Update `tool-catalog.ts` if the adapter's tools need to be in `SHARED_CORE_TOOLS` (debug tools are already there)
9. Update `permissions/index.ts` `PLAN_MODE_TOOLS` if the adapter's tools should be available in plan mode (debug tools are already there)

## Tools

### Layer 1: Primitive Tools

Interactive stepping and inspection. Each tool takes a `session_id` returned by `debug_launch`.

| Tool | Description |
|------|-------------|
| `debug_launch` | Launch a debug session (program, adapter, stop_on_entry) |
| `debug_set_breakpoint` | Set a breakpoint at file:line (with optional condition) |
| `debug_continue` | Resume execution, wait for next stop |
| `debug_locals` | Get local variables (with one level of nested struct expansion) |
| `debug_eval` | Evaluate an expression in the current frame |
| `debug_backtrace` | Get the call stack |
| `debug_terminate` | End the debug session |
| `step_in` / `step_over` / `step_out` | Step through code |
| `debug_set_variable` | Set a variable's value at runtime |
| `debug_restart` | Restart the debug session (if adapter supports it) |

### Layer 2: Composed Tools

One-call tools that handle the full launch→breakpoint→inspect→terminate lifecycle.

| Tool | Description |
|------|-------------|
| `debug_state_at` | Set breakpoint, run to it, return locals + backtrace + evaluated expressions |
| `debug_last_error` | Run until exception, return exception type/message + locals at throw site |
| `debug_trace_calls` | Run to completion, return structured call records via sentinel parsing |
| `debug_watch_change` | Watch an expression for changes across stepping |

## Skill Injection Model

Language-specific skills are **not** injected into every system prompt. They start inactive and activate on the first `debug_*` or `step_*` tool call:

1. `goSkillActive`, `pythonSkillActive`, `tsSkillActive`, `javaSkillActive`, `rubySkillActive`, `phpSkillActive` flags start `false`
2. On `tool_call` event, if tool name starts with `debug_` or `step_`, the matching flag is set based on `activeAdapters`
3. System prompt blocks check the flag: `render: () => goSkillActive ? DAP_GO_SKILL : undefined`
4. Flags reset on `session_start`

**Token impact:** A Go project with no debugging costs ~350 tokens (general prompt only). After the first debug call, ~1.3K tokens (general + Go skill).

## Known Limitations

1. **debugpy integration test** — The `debug_last_error` flow times out because debugpy defers `setExceptionBreakpoints` and `launch` responses until after `configurationDone`. The adapter config is correct; the protocol ordering needs adjustment.

2. **js-debug integration test** — The `startDebugging` handler and child-session routing are implemented and unit-tested via TCP mock server tests. Real end-to-end testing requires installing `js-debug-adapter`.

3. **`debug_trace_calls` requires sentinel instrumentation** — The program must be pre-instrumented with `__KIMCHI_TRACE__` log statements. Auto-instrumentation via DAP logpoints is planned but not yet implemented.

4. **`debug_watch_change` polling fallback** — When `supportsDataBreakpoints` is false (most adapters), the tool steps through the program one line at a time, which is slow for programs with many lines between changes.

5. **`runInTerminal` server requests** — Replied with `success: false`. Some adapters may require this for terminal-based program launching.
