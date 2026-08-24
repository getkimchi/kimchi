# Agent Skill: Debugging with DAP Tools

Guidance for the agent on **when** to reach for the DAP tools and how to run a
complete debug round-trip. All examples assume the main session has plan-mode
activated (`debug_*` tools are gated to the Plan persona).

Per-language launch configurations, source-mapping rules, and expression
syntax differences live in the reference files:

- [Go / dlv](dap-reference-go.md)
- [Python / debugpy](dap-reference-python.md)
- [TypeScript / JavaScript / js-debug](dap-reference-typescript.md)
- [Native (C/C++/Rust) / lldb-dap](dap-reference-native.md)

---

## When to debug instead of reading code

Reach for the debugger when the question is about **runtime state**, not
**source structure**:

| Situation | Tool |
|---|---|
| "What is `cache.size` at the moment the bug hits?" | `debug_state_at` |
| "Where does this value actually get set?" | `debug_watch_change` |
| "What exception was thrown and with what locals?" | `debug_last_error` |
| "Which of these 5 functions ran? In what order?" | instrumented markers + `debug_trace_calls` |
| "Walk me through what happens line by line" | `debug_launch` → `debug_set_breakpoint` → `step_over` loop |
| "Is this method virtual-dispatching to the right impl?" | `debug_eval` on the receiver, then `step_in` |

Do **not** debug when a quick code read (`grep`, `read`) answers the question —
launching a session costs seconds and compiles/tests may invalidate results.

## Tool selection cheat sheet

### One-shot (Layer 2, fire-and-forget)

These launch their own session, inspect, and terminate. Use by default.

- **`debug_state_at({file, line, evaluated?})`** — the workhorse. Sets a
  breakpoint, runs to it, returns locals + backtrace + evaluated expressions +
  stdout/stderr in one result. Answer "what are the values here" in one call.
- **`debug_last_error({program})`** — runs the program with exception
  breakpoints, returns the exception type/message plus locals and backtrace
  at the throw site. Answer "what blew up".
- **`debug_watch_change({program, file, line, expression})`** — steps from a
  breakpoint to the next one and reports old vs new value of an expression.
  Answer "who changed this".
- **`debug_trace_calls({program})`** — marker parsing **only**: returns
  records the program itself printed as `__KIMCHI_TRACE__<json>`. It does not
  inject instrumentation. If the program prints no markers, the result says
  "not instrumented" — add markers or use `debug_state_at` instead.

### Interactive (Layer 1, stateful)

For multi-stop investigations. Always pair with the returned `session_id`.

1. `debug_launch({program})` → session id returned.
2. `debug_set_breakpoint({session_id, source, line})` — as many as needed.
3. `debug_continue({session_id})` → stops at the next breakpoint.
4. `debug_locals` / `debug_eval` / `debug_backtrace` — inspect.
5. `step_over` / `step_in` / `step_out` — navigate.
6. `debug_terminate({session_id})` when done — **always terminate**; orphan
   sessions hold adapter processes.

## The reusable launch → debug → inspect workflow

```
1. debug_launch({program: "<entry point>"})
   → session_id
2. debug_set_breakpoint({session_id, source: "<file>", line: <N>})
3. debug_continue({session_id})
   → "Stopped: breakpoint at file:line (thread N)"
4. debug_eval({session_id, expression: "<suspect value>"})
   → result, or [ref N] for structured values
5. debug_locals({session_id})          # full frame scan if eval is unclear
6. step_over({session_id}) → re-eval   # watch the value evolve
7. debug_terminate({session_id})
```

## Stops, refs, and session lifetime rules

- A `variables_reference` (`[ref N]` in `debug_locals`/`debug_eval` output)
  is only valid **while the debuggee is paused at the current stop**. Resume
  (continue/step) and the adapter may invalidate it. Use
  `debug_set_variable({session_id, name, value, variables_reference})`
  immediately after the tool call that surfaced the ref.
- `step_over`/`step_in` auto-complete a pending launch (fire-and-forget
  launches wait for `configurationDone`).
- Session ids are per-launch. Nested sessions (js-debug `pwa-node`) route
  transparently to the child after `startDebugging`.
- Timeouts default to 30 s. Cold builds (first dlv run compiles the Go stdlib)
  can need more — pass `timeout_ms`.

## Failure playbooks

- **"Debuggee terminated before reaching a stop"** — the breakpoint was never
  hit. Check the file/line maps to executed code (see language refs for
  source-mapping rules), or `debug_last_error` the program.
- **`debug_eval` returns an error but the variable exists** — language-
  specific expression limits (Go: no method calls on unexported fields).
  Read the language reference; fall back to `debug_locals` nested expansion.
- **Breakpoint `verified: false`** — wrong `source` relative to what the
  adapter sees (build output paths vs source paths). Use the concrete paths
  in the reference files.
