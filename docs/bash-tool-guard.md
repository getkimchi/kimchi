# Bash-tool guard

Steers the LLM away from using `bash` for tasks that have a dedicated
non-shell tool (`read`, `edit`, `write`). The replacement tools are
cheaper (less output lands in context) and trigger LSP-aware tooling
(hover, definition, diagnostics) when reading or editing code.

## What it catches

| Category | Patterns | Suggested tool |
|---|---|---|
| **read** | `cat <file>`, `head <file>`, `tail <file>`, `less <file>`, `more <file>`, `bat <file>`, `batcat <file>`, `sed -n '<range>p' <file>` | `read` |
| **edit** | `sed -i '...' <file>`, `sed -i.bak '...' <file>`, `perl -i -pe '...' <file>`, `perl -i.bak ...`, `awk -i inplace '...' <file>` | `edit` |
| **write** | `echo ... > file`, `printf ... > file`, `cat <<EOF > file`, `cat > file <<EOF`, `tee <file>`, any `>` / `>>` to a non-stream target | `edit` / `write` |

Stream targets like `/dev/null`, `/dev/stdout`, `/dev/stderr` are not
flagged because they discard or duplicate state rather than creating it.

## What it does NOT catch (intentional)

- `grep`, `rg`, `ag` - legitimate uses outside code-search (log inspection, `/etc/`, one-off filtering)
- `find` - already a dedicated tool, plus complex queries that the dedicated `find` tool can't replace
- `ls` - already a dedicated tool
- `git`, `pnpm`, `node`, `cargo`, etc. - execution tools with no dedicated non-shell alternative
- All other shell commands - only the patterns above are guarded

## Behaviour

1. **First match per category in a session** - the LLM is steered (a
   message is injected into the conversation) explaining the better tool.
   The bash call still executes.
2. **Subsequent matches for the same category** - by default, the guard
   keeps steering on every occurrence (warn/steer-only). Hard blocking
   is opt-in: pass `blockOnThreshold: true` when registering the
   extension to refuse the bash call with a reason pointing at the
   right tool once the threshold is exceeded. Default is warn-only so
   adopting the guard never stalls a session if the replacement tool
   is unavailable or misconfigured in a given environment.
3. **Per-category counters** - `cat` doesn't burn the budget for `sed -i`.
   A session can have one read warning, one edit warning, and one write
   warning independently.
4. **Per-category thresholds** - read/edit/write can each have their own
   warn threshold. Default is 1 (warn once, then block when blocking is
   enabled). Set `warnThresholds: { read: 3 }` to be more lenient on reads.
5. **Reset on each user prompt** - counters clear on `session_start` and
   on every user `input` event so a fresh turn starts clean.
6. **Disabled in plan mode** - same rationale as `exploration-guard`:
   plan mode is for inspection, not enforcement. Deep reads during
   scoping aren't blocked.

## Explicit user request override

If the user's most recent prompt explicitly mentions the matched tool
OR expresses the intent in natural language, the guard allows the call.
The user knows what they're asking for; we don't override explicit intent.

### Program-name match (word-boundary)

- "use sed to fix this" → allows `sed -i 's/typo/fix/' foo.ts`
- "cat src/foo.ts and tell me what it does" → allows `cat src/foo.ts`
- "use echo to create a marker file" → allows `echo 'done' > marker.txt`

### Semantic intent match (catches intent without naming the tool)

Read intent:
- "read the file foo.ts" → allows `cat foo.ts`
- "show me what's in foo.ts" → allows `cat foo.ts`
- "print the contents of foo.ts" → allows `cat foo.ts`
- "view the source" → allows `less foo.ts`
- "open foo.ts" → allows `cat foo.ts`

Edit intent:
- "fix the typo in foo.ts" → allows `sed -i 's/typo/fix/' foo.ts`
- "replace foo with bar in file.ts" → allows `sed -i 's/foo/bar/' file.ts`
- "modify foo.ts" → allows `perl -i -pe ...`
- "update the file with the new value" → allows `sed -i 's/old/new/'`
- "use sed to fix this" → allows `sed -i ...`
- "edit foo.ts" → allows `sed -i ...`

Write intent:
- "write the result to output.txt" → allows `echo 'done' > output.txt`
- "create a foo.ts file" → allows `echo 'content' > foo.ts`
- "save the output to log.txt" → allows `tee log.txt`
- "put the result in output.txt" → allows `echo 'done' > output.txt`
- "echo the line to the file" → allows `echo 'done' > foo.ts`
- "redirect the output to file.txt" → allows `echo 'done' > file.txt`

### Negative cases (word-boundary match prevents false positives)

- "categorize the files" → still flags `cat foo.ts` (`cat` ⊂ `categorize` doesn't match)
- "the tool used for editing" → still flags `sed -i '...' foo.ts` (`sed` ⊂ `used` doesn't match)
- "look at the build output" → still flags `cat foo.ts` (no intent keyword)
- "please be careful" → still flags `sed -i '...' foo.ts` (no intent keyword)
- "no changes needed" → still flags `echo 'x' > foo.ts` (no intent keyword)

This is local in-memory matching - no extra LLM call, no extra context.

## Telemetry events

The extension emits domain events via `pi.events` for telemetry to observe:

| Channel | Payload | When |
|---|---|---|
| `bash_tool_guard:warn` | `{ category, tool, count }` | First match of a category (steer) |
| `bash_tool_guard:block` | `{ category, tool, count }` | Threshold exceeded (hard block; only fires when `blockOnThreshold: true`) |
| `bash_tool_guard:allowed_by_user_request` | `{ category, tool }` | User explicitly asked for the bash tool |

The payloads carry only structured fields - `category`, `tool`,
`count` - so telemetry can aggregate without receiving raw command
text. Anything that could include user data or secrets inline
(heredocs, `echo "..." > file`, sed replacement strings) stays out
of OTLP.

These events are consumed by the telemetry extension to track guard
effectiveness (how often it fires, how often users override it).

## Why this saves tokens and triggers LSP

When the LLM uses `bash` to read a file:

- The file content is streamed through the bash tool's stdout capture
  (often 100s of KB for typical code files).
- That output lands verbatim in the conversation context.
- LSP tools (`lsp_hover`, `lsp_definition`) are not consulted, so the
  LLM has no type information, no references, no diagnostics.

When the LLM uses the `read` tool instead:

- The harness truncates intelligently, shows line numbers, can request
  specific offsets/limits.
- LSP hooks fire on the file open - the next `lsp_hover` / `lsp_definition`
  call returns rich type info without re-reading the file.
- Future `edit` calls can verify the file hasn't changed (no race
  conditions vs. the model's mental model).

Same logic for `edit` (in-place `sed -i` corrupts files on regex
mismatches) and `write` (`echo > file` overwrites with no diff, no
review, no recovery).

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
and re-enabling.

### Custom thresholds

Pass per-category thresholds when registering the extension:

```typescript
import bashToolGuardExtension from "./extensions/bash-tool-guard.js"

bashToolGuardExtension(pi, {
  warnThresholds: {
    read: 3,   // tolerate more reads (deep exploration)
    edit: 0,   // block edits immediately when blocking is enabled
    write: 1,  // default: warn once, then block (when blocking is enabled)
  },
  // Hard blocking is opt-in. Default is false (warn/steer only).
  // Set to true to refuse the bash call once the threshold is exceeded.
  blockOnThreshold: false,
})
```

## Source

`src/extensions/bash-tool-guard.ts` - exports:

- `classifyBashCommand(command: string): BashClassification | null` -
  pure function, used by tests and the guard class.
- `BashToolGuard` - stateful class with per-category counters,
  per-category thresholds, and explicit-request detection (tool-name
  + semantic intent).
- `bashToolGuardExtension(pi, options?)` - default export, registers
  `session_start`, `input`, and `tool_call` handlers.
- `STEER_MESSAGE_TYPE = "bash-tool-guard-steer"` - custom message type
  for the steer messages (used by tests and renderers).

`src/extensions/bash-tool-guard-events.ts` - domain event channels:

- `BASH_TOOL_GUARD_EVENTS.WARN`
- `BASH_TOOL_GUARD_EVENTS.BLOCK`
- `BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST`

## Tests

- `src/extensions/bash-tool-guard.test.ts` - unit coverage of pattern
  detection, counters, thresholds, and explicit-request handling.
- `src/extensions/bash-tool-guard.integration.test.ts` - integration
  coverage of extension wiring, lifecycle resets, and telemetry event
  emission.
