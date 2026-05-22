# Tool Grouping Design

## Problem

Sequential tool results print one-by-one and fill the screen, making it hard to scroll through conversation history. Claude Code collapses consecutive tool calls into a single summary line ("Searched for 5 patterns, read 2 files · ctrl+o to expand"). We want the same.

## Approach

Render-time grouping via prototype patching. No tree mutation. The component tree stays intact; grouping is purely a visual decision made on each `render()` call.

Two patches, one new file.

## New file: `src/extensions/tool-grouping.ts`

Exports a single entry point: `registerToolGrouping(pi: ExtensionAPI)`. Called from `cli.ts` alongside other extensions.

### `patchAddChild()`

Patches `Container.prototype.addChild` (idempotent) to set `child._piParent = parent` on every component. This gives each `ToolExecutionComponent` a reference to its containing `chatContainer`, required for sibling scanning.

### `patchToolGroupRendering()`

Patches `ToolExecutionComponent.prototype.render`. On each call:

1. Read `this._piParent`. If absent, fall through to original render.
2. Scan `parent.children` to find the consecutive run of `ToolExecutionComponent` siblings that includes `this`. A run is broken by any child that is neither a `ToolExecutionComponent` nor a `Spacer`. Only components where `isPartial === false` (completed) are included.
3. If run length < 2, fall through to original render.
4. Derive `groupKey = group[last].toolCallId`.
5. If `isToolExpanded(groupKey)`: fall through (each tool renders normally).
6. If `this !== group[last]`: return `[]` (hidden).
7. If `this === group[last]`: return `[buildGroupSummary(group)]`.

### `buildGroupSummary(tools: ToolExecutionComponent[])`

Pure function. For each tool in the group, classifies it into a category using tool name and args:

| Tool | Args pattern | Category |
|---|---|---|
| `Read` | — | file |
| `Grep` | — | pattern |
| `LS` | — | directory |
| `Write`, `Edit`, `MultiEdit` | — | edit |
| `Bash` | command starts with `ls`, `fd`, `find` | directory |
| `Bash` | command starts with `grep`, `rg` | pattern |
| `Bash` | command starts with `cat`, `head`, `tail` | file |
| `Bash` | anything else | command |
| anything else | — | operation |

Aggregates counts and formats: `"✓  Read 3 files, searched 2 patterns  ctrl+o"`. The `ctrl+o` hint is styled dim. Singular/plural handled ("1 file" vs "2 files").

Category display names:

| Category | Singular | Plural |
|---|---|---|
| file | "read 1 file" | "read N files" |
| pattern | "searched 1 pattern" | "searched N patterns" |
| directory | "listed 1 directory" | "listed N directories" |
| edit | "made 1 edit" | "made N edits" |
| command | "ran 1 command" | "ran N commands" |
| operation | "1 operation" | "N operations" |

## Expand interaction

ctrl+o is already wired per-`toolCallId` by the upstream framework. The last tool in a group is the only visible component, and its `toolCallId` is the group key. Pressing ctrl+o calls `setExpanded(true)` on that component. On next render, `isToolExpanded(groupKey)` is true → all tools in the group fall through to their normal individual renders (single-line headers; each can be further expanded with ctrl+o to show full output).

## What is not changing

- `tool-rendering.ts` — no modifications
- Upstream `interactive-mode.js` — not touched
- `expand-state.ts` — consumed as-is, no changes
- No new per-tool config; no tree mutation; no timing dependencies on events

## Out of scope

- MCP tools, Agent spawns — always fall through (no grouping)
- Arg-based classification for non-Bash tools
- Per-tool opt-in/opt-out config
