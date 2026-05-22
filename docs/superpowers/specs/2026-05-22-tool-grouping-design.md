# Tool Grouping Design

## Problem

Sequential tool results print one-by-one and fill the screen, making it hard to scroll through conversation history. Claude Code collapses consecutive tool calls into a single summary line. We want the same.

## Visual spec

**In-progress** (last tool in the run still executing, ≥2 tools total):
```
⟳ Searching for 1 pattern, reading 3 files, listing 2 directories…
└─ $ ls /Users/ibar/castai/src/kimchi-dev/src/
```

**Completed** (all tools done, ≥2 tools total):
```
✓ Searched for 1 pattern, read 3 files, listed 2 directories  ctrl+o
```

Fewer than 2 tools in a run: each tool renders normally (existing behavior).

## Approach

Render-time grouping via prototype patching. No tree mutation. The component tree stays intact; grouping is a visual decision made on each `render()` call.

Two patches, one new file.

## New file: `src/extensions/tool-grouping.ts`

Exports a single entry point: `registerToolGrouping(pi: ExtensionAPI)`. Called from `cli.ts` alongside other extensions.

### `patchAddChild()`

Patches `Container.prototype.addChild` (idempotent) to set `child._piParent = parent` on every component. This gives each `ToolExecutionComponent` a reference to its parent container, required for sibling scanning.

### `patchToolGroupRendering()`

Patches `ToolExecutionComponent.prototype.render`. On each call:

1. Read `this._piParent`. If absent, fall through to original render.
2. Scan `parent.children` to find the consecutive run of `ToolExecutionComponent` siblings that includes `this`. A run is broken by any child that is neither a `ToolExecutionComponent` nor a `Spacer`. Both completed **and** in-progress tools are included in the run.
3. If run length < 2, fall through to original render.
4. Derive `groupKey = run[last].toolCallId`.
5. If `isToolExpanded(groupKey)`: fall through (each tool renders normally).
6. If `this !== run[last]`: return `[]` (hidden).
7. If `this === run[last]`: return `buildGroupView(run).render(width)`.

### `buildGroupView(tools: ToolExecutionComponent[], theme: Theme): ToolBlockView`

Builds the visual component for the group. The last tool is the renderer; it has access to all siblings via the run array.

**Determine state:**
- `isInProgress = run[last].isPartial === true`

**Build header text** using `classifyTool()` on all tools in the run:
- In-progress: continuous tense — `"⟳ Searching for 1 pattern, reading 3 files…"`
- Completed: past tense — `"✓ Searched for 1 pattern, read 3 files  ctrl+o"`

**In-progress only:** set `extraLines` to the current tool's abbreviated args (the child line):
- `Bash`: `"$ <command>"` (first 60 chars)
- `Read`: `"reading <path>"`
- `Grep`: `"searching <pattern>"`
- `LS`: `"ls <path>"`
- others: `"<toolName> …"`

Use `view.setBranchMode(colorFn)` and `view.setExtra([childLine])` to render the `└─` connector.

**Completed only:** no child line.

### `classifyTool(component: ToolExecutionComponent): Category`

Pure function. Reads `(component as any).toolName` and `(component as any).args`.

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

### Verb tables

**Past tense (completed):**

| Category | Singular | Plural |
|---|---|---|
| file | "read 1 file" | "read N files" |
| pattern | "searched for 1 pattern" | "searched for N patterns" |
| directory | "listed 1 directory" | "listed N directories" |
| edit | "made 1 edit" | "made N edits" |
| command | "ran 1 command" | "ran N commands" |
| operation | "1 operation" | "N operations" |

**Continuous tense (in-progress):**

| Category | Singular | Plural |
|---|---|---|
| file | "reading 1 file" | "reading N files" |
| pattern | "searching for 1 pattern" | "searching for N patterns" |
| directory | "listing 1 directory" | "listing N directories" |
| edit | "editing 1 file" | "editing N files" |
| command | "running 1 command" | "running N commands" |
| operation | "1 operation" | "N operations" |

## Expand interaction

ctrl+o is already wired per-`toolCallId` by the upstream framework. The last tool in a group is the only visible component, and its `toolCallId` is the group key. Pressing ctrl+o calls `setExpanded(true)` on that component. On next render, `isToolExpanded(groupKey)` is true → all tools in the group fall through to their normal individual renders (single-line collapsed headers; each can be further expanded with ctrl+o to show full output).

## What is not changing

- `tool-rendering.ts` — no modifications
- Upstream `interactive-mode.js` — not touched
- `expand-state.ts` — consumed as-is, no changes
- No new per-tool config; no tree mutation; no timing dependencies on events

## Out of scope

- MCP tools, Agent spawns — always fall through (no grouping)
- Arg-based classification for non-Bash tools
- Per-tool opt-in/opt-out config
