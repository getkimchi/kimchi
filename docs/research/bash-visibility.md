# Make running Bash commands inspectable

**Recommendation:** show the command's purpose, command preview and latest output in the conversation; add **`/commands` → select a command → Script / Output** for inspection. Keep `bash_control` as the model-facing tool name, but display **Bash · still running** to the user. Build this over the existing process registry and Pi UI hooks.

Research snapshot: 2026-09-25, Kimchi `e7658fac77e3e1623306019e7b288fb68295619a`, pinned `@earendil-works/pi-coding-agent` **0.85.1**. Originally researched on `research/bash-visibility`; implemented on `feat/bash-command-inspector`. The current-behavior analysis below describes the pre-implementation baseline. See [Inspect running Bash commands](../bash-commands.md) for the resulting user interface.

## What “Bash Control” actually does

It controls a command that an earlier `bash` call already started. It does not launch another script.

| Operation | Current behavior |
| --- | --- |
| `bash`, timeout ≤5 seconds | Uses upstream execution and streams output until completion. |
| `bash`, timeout >5 seconds or omitted | Starts a registry-owned process. Returns when it exits or reaches a check-in, normally after 15 seconds. Default deadline is 120 seconds. |
| `bash_control continue` | Waits for the next check-in or exit of the **same** process. “Continue” does not resume a paused process. |
| `continue` with `extend_seconds` | Also moves the auto-stop deadline; `checkin_interval` changes observation cadence separately. |
| `bash_control stop` | Aborts the process, waits for settlement, returns final output and removes its registry entry. |

After a running check-in, Kimchi's gate blocks other agent tools until all pending handles resolve, naturally exit, or human input clears the gate. Thus “background” describes process lifetime across tool calls; it does **not** promise that the agent freely performs other work concurrently. Natural exit can release the gate before the model retrieves final output. Processes are session-scoped and killed at shutdown. They are separate from the `daemon` tool and direct `!` shell commands.

Sources: [background execution](../../src/extensions/bash-background/bash-background-tool.ts), [control tool](../../src/extensions/bash-background/bash-control-tool.ts), [gate and exit ownership](../../src/extensions/bash-background/bash-control-extension.ts), [session lifecycle](../../src/extensions/bash-background/index.ts), [daemon lifecycle](../../src/extensions/daemon/daemon-control-tool.ts).

## Why it hides information

| Finding | Evidence and consequence |
| --- | --- |
| The controller knows a handle, not the script | `BashControlInput` contains `handle`, `action` and timing fields. `ProcessEntry` does not retain command, cwd, originating tool-call ID, start time or intent. The original command exists in the earlier Bash call, but there is no self-contained inspectable record. |
| Output is captured without reaching the waiting UI | `ProcessRegistry.spawn()` appends every chunk to buffers. Background `bash.execute()` emits one empty `onUpdate`, then awaits a check-in. `bash_control.execute()` ignores `_onUpdate`. A repainting timer cannot display output it never receives. |
| Generic rendering obscures the operation | `patchToolExecutionRenderers()` sends `bash_control` through the generic renderer. `humanizeToolName()` produces “Bash Control”; partial results render only a generic running label. Completed results normally collapse to a line count. |
| Adding a custom control renderer alone would not work | The generic dispatch overrides non-core tool renderers. A custom renderer attached to `bash_control` must also be allowed through this dispatch, or explicitly selected there. |
| A completed wait looks like a completed activity | Rendering timers track each tool call. A check-in finishes that call while the process remains alive; process elapsed time and terminal status need separate data. |

Sources: [registry types, spawn, snapshots and removal](../../src/extensions/bash-background/process-registry.ts), [tool rendering: `patchToolExecutionRenderers`, `renderGenericToolCall`, `renderOpenAiToolResult`](../../src/extensions/tool-rendering.ts), and the execution files above.

Two existing behaviors are easy to overlook:

1. **Ctrl+O already expands tool output**, but expansion cannot recover missing live updates or reconstruct a command from a handle. It is a global expansion action, not a per-process inspector.
2. **Registration order matters.** The earlier background extension wins the `bash` definition and delegates its rendering to upstream. The later Bash renderer in `tool-rendering.ts` is not the authoritative definition for this path. Changing only that later registration would miss it. See [CLI extension order](../../src/cli.ts) and the pinned runner's `getAllRegisteredTools()`.

## Alternatives researched

| Pattern | What to borrow | What it leaves unresolved here |
| --- | --- | --- |
| Codex `/ps` | A direct command that shows background commands and recent output; documented as up to three non-empty lines. | A snapshot alone does not supply a full script viewer or continuously updating output. The cited documentation does not establish an interactive script drill-down. [Official documentation](https://developers.openai.com/codex/cli/slash-commands). |
| Claude Code background tasks | Explicit task identity, output files and a `/tasks` surface for running shells/subagents; Ctrl+B can background a foreground command. | Its concurrency behavior differs from Kimchi's check-in gate. Importing the whole interaction would change execution policy. [Official documentation](https://code.claude.com/docs/en/interactive-mode#background-bash-commands). |
| Pi `pi-background-tasks` | Its footer dock has list/detail navigation and output scrolling, with commands such as `/jobs`, `/logs` and `/tasks`. | It owns a separate execution/notification system; adopting it would be a lifecycle migration. Its optional process-only configuration still does not make it a viewer for Kimchi's registry. [Package README](https://github.com/ismailsaleekh/pi-background-tasks#footer-dock). |
| tmux | Direct terminal observation and interaction; useful when a real interactive terminal is required. Pi's installed README recommends it for background Bash. | Switching to another terminal session adds navigation and does not explain the existing Bash Control row. It is an escape hatch, not the default solution for inspecting managed commands. [Upstream rationale](https://github.com/earendil-works/pi/pull/327). |
| Inline expansion only | Lowest navigation cost; improve the row the user already sees. | Long scripts/output can dominate scrollback, and finding one command among many remains awkward. Pair it with a focused inspector. |

The distinction from `/ps` should be useful behavior, not an unusual name: show purpose **beside the actual command**, connect repeated waits to one command identity, and provide focused script/output views. `/commands` is a proposed name, available in the inspected Kimchi command registrations; confirm package command collisions at implementation time. `/jobs` is a reasonable alternative. `/tasks` risks confusion with Kimchi's todos and agents.

### Upstream and package checks

The pinned SDK already supplies `registerCommand`, `ctx.ui.custom`, overlays, `setStatus`, tool renderers and `onUpdate`. Its Bash execution throttles output updates at 100 ms. Its render context includes shared state, expansion and invalidation. Use these facilities; no dependency or upstream patch is needed for the proposed inspector. [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) is the public reference; the installed 0.85.1 declarations and implementation were the compatibility check.

The [Pi catalog](https://pi.dev/packages) was scanned by names and descriptions, including filtered `background` and `@earendil-works` queries. Relevant candidates included `pi-background-tasks`, `@agimon-ai/doompi-runner`, `pi-patty-bg-tasks` and `pi-better-background-tasks`. The scoped results included Radius integrations; no ready-made viewer for Kimchi's registry was identified in this bounded scan. Only `pi-background-tasks` received deeper inspection. These are candidates, not tested integrations or an exhaustive package audit.

Upstream history supports using extensions, but does not prove current feature delivery:

1. [PR #327](https://github.com/earendil-works/pi/pull/327) proposed background Bash and closed unmerged. Discussion considered tmux and tool overrides.
2. [PR #4368](https://github.com/earendil-works/pi/pull/4368) proposed backgrounding direct `!` commands, explicitly excluding agent Bash calls; it also closed unmerged.
3. [Issue #8448](https://github.com/earendil-works/pi/issues/8448) requested per-block expansion defaults and closed as not planned. Do not assume the pinned SDK offers a supported per-row default-expansion policy.

**Integration choice:** decorate the existing tools for metadata and streaming, and use an extension command/overlay for inspection. Keep process execution in the existing registry. A new general process manager or patched transcript navigation is unnecessary.

## Proposed user experience

The following examples are wireframes, not screenshots of working features.

### In the conversation

```text
● Bash · Checking TypeScript · running 42s
  pnpm run typecheck
  src/example.ts(18,3): checking references…
  Latest output 2s ago · /commands to inspect
```

Show a short output tail without requiring expansion. Ctrl+O shows the submitted multiline command and a larger output window. Every subsequent wait uses the same title and command identity, with wording such as **Still running** or **Stopping**. Keep separate transcript tool calls initially; merging historical tool calls into one mutable card would require a larger rendering change.

Use **Running, Exited 0, Failed (exit N), Stopped by user, Deadline reached**, and an honest unavailable/unknown state. Do not show success because a check-in returned. “No output yet” and “Last output 35s ago” are useful observations; neither proves a hang or progress. Do not invent percentage complete.

### `/commands`

```text
Commands · this session                         1 running
> Checking TypeScript    running 42s    output 2s ago
  pnpm run typecheck

↑↓ select     Enter inspect     Esc close
```

```text
Checking TypeScript · running 42s
Command c1 · cwd /work/project · auto-stop in 78s
[Script]  Output

pnpm run typecheck

Tab switch view   PgUp/PgDn scroll   Esc back
```

```text
Checking TypeScript · running 46s
Script  [Output]                    Follow: on

...latest bounded output...

Last output 1s ago · older output omitted
PgUp/PgDn scroll   End follow latest   Esc back
```

The list uses stable command IDs and retains selection as rows update. Opening, switching tabs, scrolling and closing are read-only. The command must open during a running tool without waiting for the next model turn. Scrolling disables automatic following; End returns to the newest output. Esc closes the inspector, never kills the command. Empty state: **No managed Bash commands running in this session**.

Display the exact submitted script, preserving newlines, heredocs and quoting. For `bash script.sh`, the submitted command is only that invocation. Do not imply that opening a mutable file later shows what executed. A linked file preview, if added later, must be labeled **current file contents**; execution-time file snapshots are a separate feature.

Use a short optional model-supplied `description` for purpose, such as “Checking TypeScript” or “Parsing package metadata”. Validate its length and render it as plain display text. It is a model's description, not a security assertion. Always retain the command beside it. Fall back to a command preview when absent. Do not add another model call or a shell-intent classifier just to name the row.

## What implementation needs

| Area | Minimum change | Why |
| --- | --- | --- |
| Registry metadata | Store command, cwd, tool-call ID, optional description, start/finish times and last-output time. Expose immutable display snapshots through a list method. | The registry already owns lifecycle and output, but cannot currently list or describe commands. Do not expose mutable controllers to the panel. |
| Streaming | Emit throttled output snapshots while either `bash` or `bash_control` is waiting; detach observers/timers in `finally`. | A user should see output while waiting, independently of model check-in frequency. Reuse the ring buffer; do not create another accumulator. |
| Rendering | Provide background-aware Bash/control renderers and explicitly route control through them in the existing renderer dispatch. | Label changes and tool-local renderers alone do not bypass current suppression. Persist display metadata in result details for historical rows. |
| Inspector | Register `/commands` in the background extension. Use `ctx.ui.custom` with a list/detail component and the existing session-registry accessor. | Existing [agent conversation overlays](../../src/extensions/agents/index.ts) and [memory panel navigation](../../src/extensions/memory/memory-panel.ts) demonstrate the host patterns. |
| Completion | Retain the currently selected final display snapshot when the live entry is removed; save adequate command/outcome metadata in terminal results, including errors. | A command that exits while being inspected must become a final view, not disappear or show “running” forever. Resumed history must not pretend a process is live. |

Start with a bounded UI refresh timer while the panel or active tool wait is mounted, for example 250 ms. Refresh can read `snapshotTail()` without controlling the process. An output subscription is another option if measurements show polling costs matter; it need not become an event-bus framework. Clear timers on exit, abort, panel close and session replacement. Update only changed content; do not append the entire transcript on each tick.

`AgentSession.prompt()` in pinned Pi executes registered extension commands **before** input events and streaming queues. Therefore a correctly registered `/commands` can open without firing the human-input safety net that clears Kimchi's process gate. This is source-verified feasibility, not a live-TUI guarantee; preserve it in a regression test.

### Ownership and lifecycle constraints

| Constraint | Required behavior |
| --- | --- |
| Inspection must not become control | Never call `bash_control continue` to refresh a view: it waits, can change cadence/deadline, and can consume final output/remove the entry. Do not call `remove()` or `finalSnapshot()` casually either; the latter can create a spill file. Use a read-only display snapshot. |
| Bounded output | Current ring capacity is 65,536 bytes; default check-in tail is 8,192 bytes. Final output has a 2,000-line/50,000-byte display limit and can spill to disk. Label omitted output. Streaming UTF-8 and terminal control sequences need safe display handling. |
| Full-output files | A spill file is not guaranteed for small output; while running it may still be buffered, and shutdown deletes registry spill paths. First release promises a live bounded tail, not a permanent full-log archive. Any file link must accurately state availability. |
| Process removal and replay | Capture terminal display data before removal, including non-zero exits and thrown errors. Keep a selected final snapshot until the panel closes; historical tool results remain the longer-lived record. No unbounded completed-process list is required. |
| Scope and actions | Initially cover managed Bash commands in the current session. Direct `!` commands, daemons, worker sessions and arbitrary OS processes are separate ownership domains. Read-only inspection ships first; a later Stop action must confirm the selected command and integrate with the gate's exit-ownership logic. |

Do not add Stop, rerun, stdin attachment, OS-wide discovery or cross-agent aggregation to the first inspector. They are useful separate requirements, but none is necessary to see which script is running and whether it is producing output. In particular, `ProcessEntry` has no PID or terminal input channel; an interactive terminal is not a free extension of the viewer.

## Delivery sequence and acceptance

These are proposed implementation steps, not completed work. Engineering estimate: **2–4 days**, including regression tests and live TUI checks; the main uncertainty is rendering/lifecycle integration, not the menu itself.

1. **Capture identity and intent.** Add optional description and immutable process display metadata. Verify multiline commands, missing descriptions, cwd, check-in versus process elapsed time, and unknown handles.
2. **Make the existing row informative.** Stream output during initial Bash and control waits; route the renderers correctly. A deterministic command printing once per second must update visibly before a 15-second check-in. Check success, non-zero exit, silent commands and deadline/abort outcomes.
3. **Add `/commands` inspection.** Open while control is waiting; select by stable ID; view full submitted script and live tail; scroll without losing position. Opening/closing must leave deadlines, pending handles and model turns unchanged.
4. **Handle completion and bounded data.** Exit while the panel is open, repeated waits, large output, ANSI/control text, split Unicode, long heredocs, narrow terminals, resize, session switch and shutdown. Verify final data remains readable and no timer/listener/process leaks.
5. **Validate the user workflow.** Co-located module tests plus one deliberate `runKimchiSession` TUI scenario under `tests/e2e/tui`, using deterministic fake responses and isolated HOME/workdir. Build the candidate and use bundled `kimchi-tmux` to inspect live behavior. Run lint/typecheck and relevant tests; preserve existing shutdown/gate tests.

The feature is complete when the user can identify the command's purpose, inspect the exact submitted script, observe fresh output during a wait, and distinguish terminal outcomes without asking the model. A renamed “Bash Control” label or a passing unit suite alone does not meet that bar.

## Evidence gathered for this research

**Baseline check:** in the research worktree, `pnpm exec vitest run src/extensions/bash-background src/extensions/tool-rendering.test.ts src/extensions/tool-rendering-narrow.test.ts` passed **190 tests across 7 files**. Dependencies were shared through a temporary local `node_modules` symlink to the original checkout; the installed Pi package was confirmed as 0.85.1. This checks current contracts, not the proposed UX.

**Real-process probe:** local ignored `.kimchi/docs/bash-visibility-probe.mts`, run with `pnpm exec tsx .kimchi/docs/bash-visibility-probe.mts`, launched a harmless `printf`/`sleep` script through the actual background tool and registry. Assertions passed: the initial callback contained only empty output; the registry gained a second output line during a control wait while that wait emitted zero updates; taking snapshots left the deadline unchanged; final control returned the last line and removed the entry. The registry lacked command/cwd fields as predicted. No model calls were used.

**Source checks:** traced CLI registration order, first-registration-wins resolution, generic renderer override, global expansion behavior, extension-command dispatch, process removal and spill cleanup. Inspected existing overlay/panel implementations. External comparisons were documentation/source research; no competing package was installed or executed.

**Research-stage limit:** these baseline checks preceded the implementation and make no live TUI usability or performance claim. Candidate validation is recorded with the implementation and PR, separately from this research evidence.

**Independent review:** accepted with no material findings after checking source boundaries, comparison sources, worktree state and independently rerunning the real-process probe. The temporary dependency symlink was removed after validation. Local document links and whitespace were checked.
