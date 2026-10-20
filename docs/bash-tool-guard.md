# Bash-tool guard

Steers the LLM away from backgrounding processes with `&`, `nohup`, or
`disown`. Such processes escape the bash tool's process lifecycle: when
the bash command completes normally, the shell exits, but backgrounded
processes survive in the child's process group and are never cleaned up —
they become orphaned and keep consuming memory until the container OOMs.

The guard is the runtime layer (layer 2) of a two-layer design. Layer 1 —
the consolidated `## Tool Selection` section in the core system prompt
plus the bash tool's overridden description — carries the
read/edit/write preference (use the dedicated tools instead of
`cat` / `sed -i` / shell redirects) at zero per-turn cost.

## What it catches

| Category | Patterns | Steered |
|---|---|---|
| **background** | standalone `&` (not `&&`), `nohup` as a command token, `disown` as a command token, subshell backgrounding `(... &)` | yes — warn, then block when `blockOnThreshold: true` |

Quoted or escaped ampersands (`echo "A & B"`) and file-descriptor
redirections (`2>&1`, `>&2`) are not flagged.

## What it no longer catches (intentional)

The read / edit / write categories (`cat <file>`, `sed -i`, `echo > file`,
`tee`, heredoc redirects) are **classification-only** as of the
benchmark comparison (Oct 2026): runtime steers for them
measured 70–77% ignored, the write category was dominated by
false-positive triggers (`make | tee build.log`, dataset splits,
heredoc scripts) where the suggested tool was wrong, and removing them
cost 0.6–0.9% of run tokens with no measurable round or success-rate
effect across the 12-run series. The prompt-level preference (layer 1)
continues to carry the file-tool preference.

`classifyBashCommand()` still returns all four categories — retained for
tests and future telemetry — but only `background` steers, blocks, or
counts.

Also intentionally unguarded: `grep` / `rg` / `ag`, `find`, `ls`, and all
other shell commands with legitimate non-file-tool uses.

## Behaviour

1. **First background match in a session** - the LLM is steered (a
   message is injected into the conversation) explaining the supported
   alternatives. The bash call still executes.
2. **Subsequent background matches** - by default, the guard keeps
   steering on every occurrence (warn/steer-only). Hard blocking is
   opt-in: pass `blockOnThreshold: true` when registering the
   extension to refuse the bash call once the threshold is exceeded.
3. **Counter** - background matches accumulate; read/edit/write
   classifications never touch the counter.
4. **Threshold** - the background warn threshold defaults to 1. Set
   `warnThresholds: { background: 3 }` to be more lenient.
   read/edit/write threshold entries are inert (classification-only
   categories) and kept only for options-contract stability.
5. **Reset on each user prompt** - counters clear on `session_start` and
   on every user `input` event so a fresh turn starts clean.
6. **Disabled in plan mode** - same rationale as `exploration-guard`:
   plan mode is for inspection, not enforcement.
7. **Warn-only steer coalescing** - one steer per assistant turn, so
   parallel bash calls cannot build a steer backlog. Telemetry still
   records every warn decision.

## Steer text

The steer names the actual failure mode and both supported ways to run
a long command (mirroring the layer-1 bash description):

```
Bash-tool guard: backgrounding with `nohup python3 run.py` detaches the
process from the bash tool's lifecycle — it becomes orphaned and can
consume memory until the container OOMs.

Two supported ways to run a long command, depending on whether it must
outlive the session:
- Session-scoped: run it with the bash tool — after a brief initial
  handoff (~2s) you get a handle and it continues by default while
  other tools stay available; exit results are delivered automatically
  (do not poll); stop it via bash_control stop_handles. It is killed
  when the session ends.
- Must keep running after the session ends (e.g. a server someone
  connects to afterwards), and only then: use the `daemon` tool instead.
Never background with `&`, `nohup`, or `disown` — the process escapes
the bash tool's lifecycle and becomes orphaned, consuming memory until
the container OOMs.
```

The `daemon` line is only present when experimental features are
enabled (the daemon tools exist); otherwise the steer says to restate
the must-outlive-the-session requirement to the user before finishing.
The block reason appends: "To override, disable the bash-tool-guard
extension in resource settings."

## Explicit user request override

If the user's most recent prompt explicitly requests backgrounding —
by naming the operator ("use nohup", "disown the job") or by expressing
the intent in natural language ("run it in the background", "launch it
detached") — the guard allows the call. The user knows what they're
asking for; we don't override explicit intent. Matching is
word-boundary and case-insensitive ("disowned" does not match `disown`;
`cat`/`sed`/`echo` phrases no longer have any effect, since those
categories never steer).

## Telemetry events

The extension emits domain events via `pi.events` for telemetry to observe:

| Channel | Payload | When |
|---|---|---|
| `bash_tool_guard:warn` | `{ category, tool, count }` | Background match (steer) |
| `bash_tool_guard:block` | `{ category, tool, count }` | Background threshold exceeded (hard block; only fires when `blockOnThreshold: true`) |
| `bash_tool_guard:allowed_by_user_request` | `{ category, tool }` | User explicitly requested backgrounding |

read/edit/write matches emit no events (they no longer intervene).
The payloads carry only structured fields - `category`, `tool`,
`count` - so telemetry can aggregate without receiving raw command
text.

## Configuration

### Disabling

The extension is on by default. To disable it, set the resource toggle
in `~/.config/kimchi/harness/settings.json`:

```json
{
  "resources": {
    "extensions.bash-tool-guard": false
  }
}
```

Or via the kimchi TUI's resource toggle. The toggle is fully dynamic:
the extension is always registered and the `tool_call` handler consults
`isResourceEnabled` on every bash call, so flipping it from `/resources`
takes effect immediately without a process restart — both for disabling
and re-enabling. `KIMCHI_DISABLE_GUARD_BASH_TOOL=1` is an env kill switch
with the same effect. Disabling stops runtime guard messages; the core
prompt (layer 1) continues to prefer dedicated read/edit/write tools.

### Custom thresholds

Pass thresholds when registering the extension:

```typescript
import bashToolGuardExtension from "./extensions/bash-tool-guard.js"

bashToolGuardExtension(pi, {
  warnThresholds: {
    background: 3, // tolerate more background attempts before blocking
    // read/edit/write entries are inert (classification-only categories).
  },
  // Hard blocking is opt-in. Default is false (warn/steer only).
  // Set to true to refuse the bash call once the threshold is exceeded.
  blockOnThreshold: false,
})
```

## Source

`src/extensions/bash-tool-guard.ts` - exports:

- `classifyBashCommand(command: string): BashClassification | null` -
  pure function covering all four categories, used by tests and the
  guard class.
- `BashToolGuard` - stateful class with the background counter,
  thresholds, and explicit-request detection (tool-name + semantic
  intent).
- `bashToolGuardExtension(pi, options?)` - default export, registers
  `session_start`, `input`, `turn_start`, and `tool_call` handlers, and
  re-registers the bash tool with the layer-1 description override.
- `STEER_MESSAGE_TYPE = "bash-tool-guard-steer"` - custom message type
  for the steer messages (used by tests and renderers).

`src/extensions/bash-tool-guard-events.ts` - domain event channels:

- `BASH_TOOL_GUARD_EVENTS.WARN`
- `BASH_TOOL_GUARD_EVENTS.BLOCK`
- `BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST`

## Tests

- `src/extensions/bash-tool-guard.test.ts` - unit coverage of all four
  classification categories, the background-only decision contract
  (including the no-`NaN` steer composition regression), counters,
  thresholds, and explicit-request handling.
- `src/extensions/bash-tool-guard.integration.test.ts` - integration
  coverage of extension wiring, lifecycle resets, steer coalescing,
  telemetry event emission, and the description override.
- `tests/e2e/tui/bash-tool-guard.test.ts` and
  `tests/e2e/acp/bash-tool-guard.test.ts` - end-to-end no-steer
  (file reads) and background-steer coverage on both surfaces.
