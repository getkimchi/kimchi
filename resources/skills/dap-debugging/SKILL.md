---
name: dap-debugging
description: Diagnose runtime state with persistent DAP debugger sessions — breakpoints, expression eval, and stepping across Go, Python, TypeScript/JavaScript, and native binaries
triggers:
  - a test or build fails repeatedly and static reasoning stalls
  - a bug cannot be explained by reading code alone
  - user asks to debug a program or inspect a runtime value
category: harness
state: active
version: 1
---
# Debugging with DAP Tools

Use this skill when you need **runtime state** — a value at a line, the
exception that actually threw, which code path ran — and reading the source
no longer answers the question.

Per-language launch config, source mapping, and expression syntax rules live
in reference files alongside this skill. Load the one matching your debuggee
before launching:
`skill_view name="dap-debugging" file_path="references/go.md"`,
`references/python.md`, `references/typescript.md`, or
`references/native.md`.

## The debugging loop

Debugging is a search: you are locating the first place observable state
diverges from intended state. Each iteration narrows the search.

1. **Reproduce and name the symptom.** Run the program normally first
   (`bash`). Write down the *visible wrong thing*: wrong output, exception,
   hang. The symptom anchors every breakpoint you set.
2. **State your one-line hypothesis.** "The cache returns a stale entry
   after eviction." One line, about *data*. If you cannot, read more code —
   debugging without a hypothesis is random walking.
3. **Probe the boundary where the symptom appears.** Breakpoint at the
   observable wrong behavior (see placement rules below), inspect state.
   Ask: does it match expectations here?
4. **Move backward along the data flow.** State is wrong at your probe →
   the corruption happened earlier. Find where the bad value was *written*
   (assignment site, mutation, argument pass) and probe there. Repeat until
   you reach a probe where state is **correct** — the divergence is between
   the last correct and first incorrect probe.
5. **Minimize the step distance.** Steps between your last-correct and
   first-wrong probes may still be large. Step (`step_over` / `step_in`)
   through that window while re-evaluating the suspect expression. The
   statement where the expression flips from right to wrong is usually the
   bug — or one line away from it.
6. **Fix, then verify at the same breakpoint.** Re-run to the same probe
   with the fix and confirm state is now correct. Do not skip the
   verification pass.

Give up on a thread after ~3 empty iterations: if three probes reveal no
new divergence, your hypothesis is stale — stop, re-read the code around
the data flow, form a new one, or report what you ruled out. **Never
escalate into longer debugging sessions with fewer details each time**;
that pattern produces cost without signal.

## Where to set breakpoints

Placement is the highest-leverage decision. Prefer the probe that splits
the remaining search space, not the nearest line.

- **The symptom line itself** — the `return`, `print`, `write`, or UI
  update that surfaces the wrong behavior. Confirms inputs to the symptom.
- **The decision point** — the `if`/`switch`/loop where behavior diverges.
  Evaluating the condition plus its operands tells you which side of the
  truth table the program took and why.
- **Function entry of the wrong-returning function** — check *arguments
  in* against *expectation*. If arguments are already wrong, the bug is in
  the caller; move up the stack (see `debug_backtrace` frames).
- **The mutation point** — the line that writes the corrupted value:
  assignment, `append`/`push`, map insert, struct field set, callback
  registration. If you don't know which of several writers is guilty, use
  `debug_watch_change` on the expression to catch the changer red-handed.
- **Error handling boundaries** — `catch`/`except` blocks, `if err != nil`
  guards, `.catch()` chains where the error path diverges from the happy
  path.
- **Loop boundaries** — first and last iteration where behavior changes;
  evaluate the loop invariant and the index.
- **Async/join boundaries** — where a promise resolves, a goroutine joins,
  a message is received: the value crossing the boundary is the suspect.

Avoid:
- Library/framework interiors you didn't write — probe *your* call into
  them and *their* call back into you.
- Lines that execute millions of times (inner hot loops) — a conditional
  probe via `debug_watch_change`, or a breakpoint at the loop's *exit*, is
  cheaper than stepping through.
- Comment-only or declaration-only lines — many adapters resolve those to
  the next statement, which may be a different block than you expect.

## Finding the interesting state

Once stopped, the question is "which of the 40 visible variables is the
interesting one?"

- **Start from the hypothesis variable.** The one you named in step 2.
  `debug_eval` it first. Wrong → keep digging here. Right → the interesting
  state is elsewhere; don't wander.
- **Follow the data backward, not the code forward.** For each value that
  is wrong, ask *who could have written it*. Evaluate its immediate
  producers (arguments at call site, fields of its container). This walks
  you along the causality chain instead of dumping everything.
- **Inspect structures, not just primitives.** The bug is usually a field
  you didn't think to check. `debug_locals` expands nested fields one to
  two levels; for deeper, eval explicit field paths (`a.b.c`); check the
  language reference for expansion limits (dlv: 64 elements, 2 levels).
- **Compare expected vs actual, explicitly.** At every probe, write both
  down. The *shape* of the discrepancy is the clue: off-by-one → loop
  bounds; stale value → caching/ordering; truncated → pagination/limits;
  wrong type → conversion site; `nil`/`None`/`undefined` → initialization
  or error swallow.
- **Cross the frame boundary when the caller is suspect.** Use
  `debug_backtrace`, then inspect a higher frame's locals to see the
  arguments that produced this state.
- **When you don't know *where*** the mutation happens, don't random-
  breakpoint: `debug_watch_change({file, line, expression})` at a stable
  line and let it report the changer.
- **When you don't know *what* should run**, probe the dispatcher: eval
  the flag/route/method table that selects the code path at the decision
  point.
- **Structured values and `variables_reference`.** `debug_locals` and
  `debug_eval` tag expandable values with `[ref N]`. Refs are valid only
  while paused at the *current* stop and adapters may expire them on
  resume — call `debug_set_variable(..., variables_reference: N)` or
  expand children immediately, not after `debug_continue`.

## Tool selection cheat sheet

### One-shot (fire-and-forget) — default choice

- **`debug_state_at({file, line, evaluated?})`** — the workhorse probe:
  breakpoints + run + locals + backtrace + evaluated expressions + output
  in one result. Use it for loop steps 3–4 above.
- **`debug_last_error({program})`** — runs with exception breakpoints;
  returns exception type/message plus locals + backtrace at the throw
  site. Start here when the symptom is a crash.
- **`debug_watch_change({file, line, expression})`** — reports old vs new
  for an expression across stops: "who changed this".
- **`debug_trace_calls({program})`** — marker parsing **only**: returns
  records the program printed as `__KIMCHI_TRACE__<json>`. Nothing is
  instrumented for you; no markers means "not instrumented" — add markers
  or use `debug_state_at`.

### Interactive (stateful) — multi-stop investigations

1. `debug_launch({program})` → `session_id`.
2. `debug_set_breakpoint({session_id, source, line})` — set several along
   the suspected data flow at once; cheaper than relaunching.
3. `debug_continue({session_id})` → next stop.
4. `debug_locals` / `debug_eval` / `debug_backtrace` — inspect.
5. `step_over` / `step_in` / `step_out` — narrow the window (loop step 5).
6. `debug_terminate({session_id})` when done — **always terminate**; orphan
   sessions hold adapter processes.

Rules: `step_*` auto-completes a pending launch. js-debug nested sessions
(`startDebugging`) route to the child transparently. Default timeout is
30 s; cold builds (first Go launch compiles the stdlib) need a larger
`timeout_ms`.

## Failure playbooks

- **"Debuggee terminated before reaching a stop"** — breakpoint never hit:
  check source mapping in the language reference (compiled paths vs build
  paths), verify the line actually executes (the code may be inlined or
  dead), or run `debug_last_error` if the process crashed on the way.
- **Breakpoint `verified: false`** — path mismatch between what you passed
  and what the adapter sees; use the concrete path forms in the language
  reference.
- **`debug_eval` errors but the variable exists** — expression-syntax
  limits in that adapter (dlv: no method calls, especially on unexported
  fields). Simplify to a bare field path, or inspect via `debug_locals`.
- **Values look optimized-out / locals missing (native, release builds)**
  — rebuild with debug info (`-g`, debug profile); see references/native.md.
- **Empty or contradictory sessions** — terminate and report what you've
  ruled out rather than launching again with less detail.

## Humility rules

- The debugger shows state, not cause. Infer cause from the *difference*
  between two probes, never from one.
- A failed hypothesis is useful output — record what you ruled out so the
  next attempt (human or agent) doesn't repeat it.
- Do not present guesses from reading locals as confirmed behavior; say
  "state at file:line showed X, which means Y because Z was W".
