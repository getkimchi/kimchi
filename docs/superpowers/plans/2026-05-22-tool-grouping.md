# Tool Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive completed tool calls into a single summary line, matching Claude Code's UX — in-progress shows continuous tense + current command child, completed shows past tense + ctrl+o hint.

**Architecture:** Render-time prototype patching in a new self-contained `src/extensions/tool-grouping.ts`. A `WeakMap` tracks parent containers for sibling scanning. `ToolExecutionComponent.prototype.render` is patched so all tools except the last in a group return `[]`; the last returns a `ToolBlockView` summary. No tree mutation; no changes to `tool-rendering.ts` or upstream files.

**Tech Stack:** TypeScript, `@earendil-works/pi-tui` (Container, Spacer, ToolBlockView), `@earendil-works/pi-coding-agent` (ToolExecutionComponent), vitest.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `src/extensions/tool-grouping.ts` | Create | All grouping logic + extension entry point |
| `src/extensions/tool-grouping.test.ts` | Create | Unit tests for pure functions and patches |
| `src/cli.ts` | Modify (2 lines) | Import + register the new extension |

---

## Task 1: `classifyTool` and `formatSummary` — pure functions

**Files:**
- Create: `src/extensions/tool-grouping.ts`
- Create: `src/extensions/tool-grouping.test.ts`

These are the only two pure functions in the module. Test them first.

- [ ] **Step 1: Write failing tests**

Create `src/extensions/tool-grouping.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { classifyTool, formatSummary } from "./tool-grouping.js"

describe("classifyTool", () => {
  it("classifies read tool as file", () => {
    expect(classifyTool("read", { path: "foo.ts" })).toBe("file")
  })
  it("classifies grep as pattern", () => {
    expect(classifyTool("grep", { pattern: "foo" })).toBe("pattern")
  })
  it("classifies find as pattern", () => {
    expect(classifyTool("find", { pattern: "*.ts" })).toBe("pattern")
  })
  it("classifies ls as directory", () => {
    expect(classifyTool("ls", {})).toBe("directory")
  })
  it("classifies write as edit", () => {
    expect(classifyTool("write", { file_path: "foo.ts" })).toBe("edit")
  })
  it("classifies edit as edit", () => {
    expect(classifyTool("edit", { file_path: "foo.ts" })).toBe("edit")
  })
  it("classifies multiedit as edit", () => {
    expect(classifyTool("multiedit", {})).toBe("edit")
  })
  it("classifies bash ls as directory", () => {
    expect(classifyTool("bash", { command: "ls src/" })).toBe("directory")
  })
  it("classifies bash fd as directory", () => {
    expect(classifyTool("bash", { command: "fd . src/" })).toBe("directory")
  })
  it("classifies bash find as directory", () => {
    expect(classifyTool("bash", { command: "find . -name '*.ts'" })).toBe("directory")
  })
  it("classifies bash grep as pattern", () => {
    expect(classifyTool("bash", { command: "grep -r foo src/" })).toBe("pattern")
  })
  it("classifies bash rg as pattern", () => {
    expect(classifyTool("bash", { command: "rg 'pattern' src/" })).toBe("pattern")
  })
  it("classifies bash cat as file", () => {
    expect(classifyTool("bash", { command: "cat src/foo.ts" })).toBe("file")
  })
  it("classifies bash head as file", () => {
    expect(classifyTool("bash", { command: "head -20 foo.ts" })).toBe("file")
  })
  it("classifies bash tail as file", () => {
    expect(classifyTool("bash", { command: "tail -f log" })).toBe("file")
  })
  it("classifies bash git as command", () => {
    expect(classifyTool("bash", { command: "git status" })).toBe("command")
  })
  it("classifies unknown tool as operation", () => {
    expect(classifyTool("some_mcp_tool", {})).toBe("operation")
  })
})

describe("formatSummary", () => {
  it("formats past tense singular file", () => {
    expect(formatSummary(new Map([["file", 1]]), false)).toBe("read 1 file")
  })
  it("formats past tense plural files", () => {
    expect(formatSummary(new Map([["file", 3]]), false)).toBe("read 3 files")
  })
  it("formats past tense pattern", () => {
    expect(formatSummary(new Map([["pattern", 2]]), false)).toBe("searched for 2 patterns")
  })
  it("formats past tense directory singular", () => {
    expect(formatSummary(new Map([["directory", 1]]), false)).toBe("listed 1 directory")
  })
  it("formats past tense directory plural", () => {
    expect(formatSummary(new Map([["directory", 2]]), false)).toBe("listed 2 directories")
  })
  it("formats past tense edit", () => {
    expect(formatSummary(new Map([["edit", 1]]), false)).toBe("made 1 edit")
  })
  it("formats past tense command", () => {
    expect(formatSummary(new Map([["command", 3]]), false)).toBe("ran 3 commands")
  })
  it("formats past tense operation", () => {
    expect(formatSummary(new Map([["operation", 2]]), false)).toBe("2 operations")
  })
  it("formats continuous tense file", () => {
    expect(formatSummary(new Map([["file", 2]]), true)).toBe("reading 2 files")
  })
  it("formats continuous tense pattern singular", () => {
    expect(formatSummary(new Map([["pattern", 1]]), true)).toBe("searching for 1 pattern")
  })
  it("formats continuous tense directory", () => {
    expect(formatSummary(new Map([["directory", 2]]), true)).toBe("listing 2 directories")
  })
  it("formats continuous tense command", () => {
    expect(formatSummary(new Map([["command", 1]]), true)).toBe("running 1 command")
  })
  it("formats continuous tense edit", () => {
    expect(formatSummary(new Map([["edit", 1]]), true)).toBe("editing 1 file")
  })
  it("joins multiple categories with comma", () => {
    expect(
      formatSummary(new Map([["file", 2], ["pattern", 1]]), false)
    ).toBe("read 2 files, searched for 1 pattern")
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: FAIL — `Cannot find module './tool-grouping.js'`

- [ ] **Step 3: Implement `classifyTool` and `formatSummary`**

Create `src/extensions/tool-grouping.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent"
import { Container, Spacer } from "@earendil-works/pi-tui"
import { ToolBlockView } from "../components/tool-block.js"
import { isToolExpanded } from "../expand-state.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Category = "file" | "pattern" | "directory" | "edit" | "command" | "operation"

// ---------------------------------------------------------------------------
// classifyTool
// ---------------------------------------------------------------------------

const BASH_DIRECTORY_CMDS = new Set(["ls", "fd", "find"])
const BASH_PATTERN_CMDS = new Set(["grep", "rg"])
const BASH_FILE_CMDS = new Set(["cat", "head", "tail"])

export function classifyTool(toolName: string, args: Record<string, unknown>): Category {
  switch (toolName) {
    case "read":
      return "file"
    case "grep":
    case "find":
      return "pattern"
    case "ls":
      return "directory"
    case "write":
    case "edit":
    case "multiedit":
      return "edit"
    case "bash": {
      const command = typeof args.command === "string" ? args.command.trim() : ""
      const firstWord = command.split(/\s+/)[0] ?? ""
      if (BASH_DIRECTORY_CMDS.has(firstWord)) return "directory"
      if (BASH_PATTERN_CMDS.has(firstWord)) return "pattern"
      if (BASH_FILE_CMDS.has(firstWord)) return "file"
      return "command"
    }
    default:
      return "operation"
  }
}

// ---------------------------------------------------------------------------
// formatSummary
// ---------------------------------------------------------------------------

const PAST: Record<Category, (n: number) => string> = {
  file: (n) => `read ${n} ${n === 1 ? "file" : "files"}`,
  pattern: (n) => `searched for ${n} ${n === 1 ? "pattern" : "patterns"}`,
  directory: (n) => `listed ${n} ${n === 1 ? "directory" : "directories"}`,
  edit: (n) => `made ${n} ${n === 1 ? "edit" : "edits"}`,
  command: (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`,
  operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

const CONTINUOUS: Record<Category, (n: number) => string> = {
  file: (n) => `reading ${n} ${n === 1 ? "file" : "files"}`,
  pattern: (n) => `searching for ${n} ${n === 1 ? "pattern" : "patterns"}`,
  directory: (n) => `listing ${n} ${n === 1 ? "directory" : "directories"}`,
  edit: (n) => `editing ${n} ${n === 1 ? "file" : "files"}`,
  command: (n) => `running ${n} ${n === 1 ? "command" : "commands"}`,
  operation: (n) => `${n} ${n === 1 ? "operation" : "operations"}`,
}

/** Formats aggregated category counts into a summary string.
 *  Map key order determines the display order (first appearance wins). */
export function formatSummary(counts: Map<Category, number>, isInProgress: boolean): string {
  const table = isInProgress ? CONTINUOUS : PAST
  return Array.from(counts.entries())
    .map(([cat, n]) => table[cat](n))
    .join(", ")
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: all `classifyTool` and `formatSummary` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-grouping.ts src/extensions/tool-grouping.test.ts
git commit -m "feat(tool-grouping): classifyTool and formatSummary pure functions"
```

---

## Task 2: `patchAddChild` and `getParent`

**Files:**
- Modify: `src/extensions/tool-grouping.ts`
- Modify: `src/extensions/tool-grouping.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/extensions/tool-grouping.test.ts`:

```typescript
import { Container } from "@earendil-works/pi-tui"
import { getParent, patchAddChild } from "./tool-grouping.js"

describe("patchAddChild / getParent", () => {
  it("returns undefined for a component with no parent", () => {
    patchAddChild()
    const child = new Container()
    expect(getParent(child)).toBeUndefined()
  })

  it("records parent when addChild is called", () => {
    patchAddChild()
    const parent = new Container()
    const child = new Container()
    parent.addChild(child)
    expect(getParent(child)).toBe(parent)
  })

  it("is idempotent — calling patchAddChild twice does not double-wrap", () => {
    patchAddChild()
    patchAddChild()
    const parent = new Container()
    const child = new Container()
    parent.addChild(child)
    expect(getParent(child)).toBe(parent)
  })

  it("returns the closest parent when re-added to a different container", () => {
    patchAddChild()
    const parent1 = new Container()
    const parent2 = new Container()
    const child = new Container()
    parent1.addChild(child)
    parent2.addChild(child)
    expect(getParent(child)).toBe(parent2)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: FAIL — `getParent is not a function` / `patchAddChild is not a function`

- [ ] **Step 3: Implement `patchAddChild` and `getParent`**

Add to `src/extensions/tool-grouping.ts` (after the `formatSummary` section):

```typescript
// ---------------------------------------------------------------------------
// Parent tracking via WeakMap
// ---------------------------------------------------------------------------

const ADDCHILD_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-addchild")
const parentMap = new WeakMap<object, Container>()

export function getParent(component: object): Container | undefined {
  return parentMap.get(component)
}

export function patchAddChild(): void {
  const proto = Container.prototype as any
  if (proto[ADDCHILD_PATCH_FLAG]) return
  const original = proto.addChild
  proto.addChild = function patchedAddChild(component: object) {
    parentMap.set(component, this)
    return original.call(this, component)
  }
  proto[ADDCHILD_PATCH_FLAG] = true
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: all parent-tracking tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-grouping.ts src/extensions/tool-grouping.test.ts
git commit -m "feat(tool-grouping): WeakMap-based parent tracking via patchAddChild"
```

---

## Task 3: `findToolGroup`

**Files:**
- Modify: `src/extensions/tool-grouping.ts`
- Modify: `src/extensions/tool-grouping.test.ts`

`findToolGroup` scans a parent's children to find the consecutive run of tool-like components that contains a given component. Uses duck typing — no direct `ToolExecutionComponent` import needed here.

A "tool-like" component: has string `toolName` and `toolCallId`.
Spacer: `instanceof Spacer` — transparent (skip, don't break).
Failed tool: `(component as any).result?.isError === true` — breaks the run (excluded).
Any other non-tool, non-Spacer child: breaks the run.

- [ ] **Step 1: Write failing tests**

Add to `src/extensions/tool-grouping.test.ts`:

```typescript
import { Spacer } from "@earendil-works/pi-tui"
import { findToolGroup } from "./tool-grouping.js"

function mockTool(id: string, opts: { isPartial?: boolean; isError?: boolean } = {}): object {
  return {
    toolName: "bash",
    toolCallId: id,
    args: { command: "git status" },
    isPartial: opts.isPartial ?? false,
    result: opts.isError ? { isError: true } : undefined,
    render: (_width: number) => [],
    invalidate: () => {},
  }
}

describe("findToolGroup", () => {
  it("returns [self] when alone in parent", () => {
    const tool = mockTool("a")
    const children = [tool]
    expect(findToolGroup(tool, children)).toEqual([tool])
  })

  it("groups two consecutive completed tools", () => {
    const a = mockTool("a")
    const b = mockTool("b")
    const children = [a, b]
    expect(findToolGroup(a, children)).toEqual([a, b])
    expect(findToolGroup(b, children)).toEqual([a, b])
  })

  it("spacers are transparent — do not break the run", () => {
    const a = mockTool("a")
    const spacer = new Spacer(1)
    const b = mockTool("b")
    const children = [a, spacer, b]
    expect(findToolGroup(a, children)).toEqual([a, b])
    expect(findToolGroup(b, children)).toEqual([a, b])
  })

  it("spacers are not included in the returned run array", () => {
    const a = mockTool("a")
    const spacer = new Spacer(1)
    const b = mockTool("b")
    const children = [a, spacer, b]
    const group = findToolGroup(a, children)
    expect(group).not.toContain(spacer)
  })

  it("non-tool, non-spacer breaks the run", () => {
    const a = mockTool("a")
    const b = mockTool("b")
    const other = { render: () => [], invalidate: () => {} } // not a tool, not a spacer
    const c = mockTool("c")
    const children = [a, b, other, c]
    expect(findToolGroup(a, children)).toEqual([a, b])
    expect(findToolGroup(c, children)).toEqual([c])
  })

  it("failed tool (isError) breaks the run — excluded from group", () => {
    const a = mockTool("a")
    const b = mockTool("b", { isError: true })
    const c = mockTool("c")
    const children = [a, b, c]
    // b breaks the run: a is isolated, c is isolated, b is isolated
    expect(findToolGroup(a, children)).toEqual([a])
    expect(findToolGroup(c, children)).toEqual([c])
  })

  it("in-progress tools are included in the run", () => {
    const a = mockTool("a")
    const b = mockTool("b", { isPartial: true })
    const children = [a, b]
    expect(findToolGroup(b, children)).toEqual([a, b])
  })

  it("returns correct run when self is not present in children", () => {
    const a = mockTool("a")
    const b = mockTool("b")
    const other = mockTool("x")
    const children = [a, b]
    // other is not in children — return just [other]
    expect(findToolGroup(other, children)).toEqual([other])
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: FAIL — `findToolGroup is not a function`

- [ ] **Step 3: Implement `findToolGroup`**

Add to `src/extensions/tool-grouping.ts`:

```typescript
// ---------------------------------------------------------------------------
// findToolGroup
// ---------------------------------------------------------------------------

function isToolLike(v: unknown): v is { toolName: string; toolCallId: string; isPartial: boolean; args: Record<string, unknown> } {
  if (!v || typeof v !== "object") return false
  const c = v as Record<string, unknown>
  return typeof c.toolName === "string" && typeof c.toolCallId === "string"
}

function isFailedTool(v: unknown): boolean {
  if (!isToolLike(v)) return false
  const c = v as any
  return c.result?.isError === true
}

/** Returns the consecutive run of tool-like components (no Spacers, no failed tools)
 *  that includes `self`. Spacers are transparent. Failed tools break the run.
 *  If `self` is not found in `children`, returns `[self]`. */
export function findToolGroup(self: object, children: object[]): object[] {
  const selfIdx = children.indexOf(self)

  // Find effective boundaries by scanning backward and forward, skipping Spacers.
  const tools: object[] = []

  if (selfIdx === -1) {
    // self not in children — lone group
    return isFailedTool(self) ? [] : [self]
  }

  // Walk backward from selfIdx to find start of run
  let start = selfIdx
  for (let i = selfIdx - 1; i >= 0; i--) {
    const child = children[i]
    if (child instanceof Spacer) continue
    if (!isToolLike(child) || isFailedTool(child)) break
    start = i
  }

  // Walk forward from selfIdx to find end of run
  let end = selfIdx
  for (let i = selfIdx + 1; i < children.length; i++) {
    const child = children[i]
    if (child instanceof Spacer) continue
    if (!isToolLike(child) || isFailedTool(child)) break
    end = i
  }

  // Collect tools in [start..end], skipping Spacers and failed tools
  for (let i = start; i <= end; i++) {
    const child = children[i]
    if (child instanceof Spacer) continue
    if (!isToolLike(child) || isFailedTool(child)) continue
    tools.push(child)
  }

  return tools
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: all `findToolGroup` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-grouping.ts src/extensions/tool-grouping.test.ts
git commit -m "feat(tool-grouping): findToolGroup with Spacer transparency and error-break"
```

---

## Task 4: `buildGroupSummaryText` and `buildCurrentToolLine`

**Files:**
- Modify: `src/extensions/tool-grouping.ts`
- Modify: `src/extensions/tool-grouping.test.ts`

These two helpers feed into `buildGroupView`. Test them independently first.

`buildGroupSummaryText` takes a run of tool-like objects, aggregates categories in first-appearance order, and returns the formatted string (without icon/ellipsis — caller adds those).

`buildCurrentToolLine` takes the in-progress tool and returns an abbreviated child line string.

- [ ] **Step 1: Write failing tests**

Add to `src/extensions/tool-grouping.test.ts`:

```typescript
import { buildCurrentToolLine, buildGroupSummaryText } from "./tool-grouping.js"

function mockToolFull(
  toolName: string,
  args: Record<string, unknown>,
  opts: { isPartial?: boolean } = {}
): object {
  return {
    toolName,
    toolCallId: Math.random().toString(36),
    args,
    isPartial: opts.isPartial ?? false,
    result: undefined,
    render: (_width: number) => [],
    invalidate: () => {},
  }
}

describe("buildGroupSummaryText", () => {
  it("aggregates by category, first-appearance order", () => {
    const run = [
      mockToolFull("read", { path: "a.ts" }),
      mockToolFull("bash", { command: "ls src/" }),
      mockToolFull("read", { path: "b.ts" }),
      mockToolFull("grep", { pattern: "foo" }),
    ]
    expect(buildGroupSummaryText(run, false)).toBe(
      "read 2 files, listed 1 directory, searched for 1 pattern"
    )
  })

  it("uses continuous tense when isInProgress is true", () => {
    const run = [
      mockToolFull("read", { path: "a.ts" }),
      mockToolFull("bash", { command: "git status" }),
    ]
    expect(buildGroupSummaryText(run, true)).toBe("reading 1 file, running 1 command")
  })
})

describe("buildCurrentToolLine", () => {
  it("bash tool shows $ prefix with command", () => {
    const tool = mockToolFull("bash", { command: "git diff HEAD~1" })
    expect(buildCurrentToolLine(tool)).toBe("$ git diff HEAD~1")
  })

  it("bash command truncated to 60 chars", () => {
    const long = "x".repeat(80)
    const tool = mockToolFull("bash", { command: long })
    const line = buildCurrentToolLine(tool)
    expect(line.startsWith("$ ")).toBe(true)
    expect(line.length).toBeLessThanOrEqual(62) // "$ " + 60
  })

  it("read tool shows reading prefix with path", () => {
    const tool = mockToolFull("read", { path: "src/foo.ts" })
    expect(buildCurrentToolLine(tool)).toBe("reading src/foo.ts")
  })

  it("grep tool shows searching prefix with pattern", () => {
    const tool = mockToolFull("grep", { pattern: "TODO" })
    expect(buildCurrentToolLine(tool)).toBe('searching "TODO"')
  })

  it("ls tool shows ls prefix with path", () => {
    const tool = mockToolFull("ls", { path: "src/" })
    expect(buildCurrentToolLine(tool)).toBe("ls src/")
  })

  it("ls tool defaults to . when no path", () => {
    const tool = mockToolFull("ls", {})
    expect(buildCurrentToolLine(tool)).toBe("ls .")
  })

  it("unknown tool shows toolName …", () => {
    const tool = mockToolFull("some_mcp_tool", {})
    expect(buildCurrentToolLine(tool)).toBe("some_mcp_tool …")
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: FAIL — `buildGroupSummaryText is not a function` / `buildCurrentToolLine is not a function`

- [ ] **Step 3: Implement both functions**

Add to `src/extensions/tool-grouping.ts`:

```typescript
// ---------------------------------------------------------------------------
// buildGroupSummaryText
// ---------------------------------------------------------------------------

/** Aggregates tool categories in first-appearance order and formats as a
 *  summary string. Icon and ellipsis are NOT included — caller adds them. */
export function buildGroupSummaryText(run: object[], isInProgress: boolean): string {
  const order: Category[] = []
  const counts = new Map<Category, number>()
  for (const tool of run) {
    if (!isToolLike(tool)) continue
    const cat = classifyTool(tool.toolName, tool.args)
    if (!counts.has(cat)) order.push(cat)
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  const orderedCounts = new Map(order.map((cat) => [cat, counts.get(cat)!]))
  return formatSummary(orderedCounts, isInProgress)
}

// ---------------------------------------------------------------------------
// buildCurrentToolLine
// ---------------------------------------------------------------------------

/** Returns an abbreviated child line string for the currently in-progress tool. */
export function buildCurrentToolLine(tool: object): string {
  if (!isToolLike(tool)) return "…"
  const { toolName, args } = tool
  switch (toolName) {
    case "bash": {
      const cmd = typeof args.command === "string" ? args.command.slice(0, 60) : ""
      return `$ ${cmd}`
    }
    case "read": {
      const path = typeof args.path === "string" ? args.path : ""
      return `reading ${path}`
    }
    case "grep":
    case "find": {
      const pattern = typeof args.pattern === "string" ? args.pattern : ""
      return `searching "${pattern}"`
    }
    case "ls": {
      const path = typeof args.path === "string" ? args.path : "."
      return `ls ${path}`
    }
    default:
      return `${toolName} …`
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run src/extensions/tool-grouping.test.ts
```

Expected: all `buildGroupSummaryText` and `buildCurrentToolLine` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-grouping.ts src/extensions/tool-grouping.test.ts
git commit -m "feat(tool-grouping): buildGroupSummaryText and buildCurrentToolLine"
```

---

## Task 5: `buildGroupView` and `patchToolGroupRendering`

**Files:**
- Modify: `src/extensions/tool-grouping.ts`

These are the rendering functions. `buildGroupView` assembles a `ToolBlockView`. `patchToolGroupRendering` is the core patch that intercepts `ToolExecutionComponent.prototype.render`.

No unit tests here — the rendering depends on `ToolBlockView` internals and a real theme. The full test is manual (run the app). We verify correctness of the render patch logic via the existing helpers which are already tested.

- [ ] **Step 1: Implement `buildGroupView`**

Add to `src/extensions/tool-grouping.ts`:

```typescript
// ---------------------------------------------------------------------------
// buildGroupView
// ---------------------------------------------------------------------------

const GROUP_RENDER_PATCH_FLAG = Symbol.for("pi-tool-grouping:patched-render")

/** Builds a ToolBlockView for the collapsed group summary.
 *  `run` must be non-empty; last element is the current renderer. */
function buildGroupView(run: object[], theme: any): ToolBlockView {
  const view = new ToolBlockView()
  const last = run[run.length - 1] as any
  const isInProgress = last?.isPartial === true
  const summaryText = buildGroupSummaryText(run, isInProgress)

  if (isInProgress) {
    const icon = theme?.fg?.("accent", "⟳") ?? "⟳"
    view.setHeader(`${icon} ${summaryText}…`, theme?.fg?.("dim", "(ctrl+o to expand)") ?? "(ctrl+o)")
    view.setBranchMode((s: string) => theme?.fg?.("borderMuted", s) ?? s)
    view.setExtra([theme?.fg?.("dim", buildCurrentToolLine(last)) ?? buildCurrentToolLine(last)])
  } else {
    const icon = theme?.fg?.("success", "✓") ?? "✓"
    view.setHeader(
      `${icon} ${summaryText}`,
      theme?.fg?.("dim", "ctrl+o") ?? "ctrl+o",
    )
    view.hideDivider()
    view.setFooter("", "")
    view.setExtra([])
  }

  return view
}
```

- [ ] **Step 2: Implement `patchToolGroupRendering`**

Add to `src/extensions/tool-grouping.ts`:

```typescript
// ---------------------------------------------------------------------------
// patchToolGroupRendering
// ---------------------------------------------------------------------------

export function patchToolGroupRendering(): void {
  const proto = ToolExecutionComponent.prototype as any
  if (proto[GROUP_RENDER_PATCH_FLAG]) return

  const originalRender = proto.render

  proto.render = function patchedGroupRender(width: number): string[] {
    const parent = getParent(this)
    if (!parent) return originalRender.call(this, width)

    const run = findToolGroup(this, parent.children)
    if (run.length < 2) return originalRender.call(this, width)

    const groupKey = (run[run.length - 1] as any).toolCallId
    if (isToolExpanded(groupKey)) return originalRender.call(this, width)

    if (run[run.length - 1] !== this) return []

    // Grab theme from the upstream component's ui reference (same pattern as
    // interactive-mode.js which stores ui on the component instance).
    const theme = (this as any).ui?.theme
    return buildGroupView(run, theme).render(width)
  }

  proto[GROUP_RENDER_PATCH_FLAG] = true
}
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/tool-grouping.ts
git commit -m "feat(tool-grouping): buildGroupView and patchToolGroupRendering"
```

---

## Task 6: `registerToolGrouping` + wire into `cli.ts`

**Files:**
- Modify: `src/extensions/tool-grouping.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Add `registerToolGrouping` export to `tool-grouping.ts`**

Add at the end of `src/extensions/tool-grouping.ts`:

```typescript
// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function registerToolGrouping(_pi: ExtensionAPI): void {
  patchAddChild()
  patchToolGroupRendering()
}
```

- [ ] **Step 2: Add import to `cli.ts`**

Find the block of extension imports (around line 20–52). Add after the `toolRenderingExtension` import:

```typescript
import toolGroupingExtension from "./extensions/tool-grouping.js"
```

- [ ] **Step 3: Register the extension in the `extensionFactories` array**

Find the `extensionFactories` array in `cli.ts` (around line 455). Add `toolGroupingExtension` immediately after `toolRenderingExtension`:

```typescript
toolRenderingExtension,
toolGroupingExtension,
```

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: all existing tests pass, new tool-grouping tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/tool-grouping.ts src/cli.ts
git commit -m "feat(tool-grouping): register extension in cli.ts"
```

---

## Task 7: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Build and run**

```bash
pnpm build && node dist/entry.js
```

- [ ] **Step 2: Trigger a multi-tool run**

Ask the assistant to do something that fires ≥2 tools in a row (e.g. "read two files and search for a pattern"). Verify:

1. While tools are running: `⟳ reading 1 file, searching for 1 pattern… (ctrl+o to expand)` with `└─ $ <current command>` child line
2. After all complete: `✓ read 2 files, searched for 1 pattern  ctrl+o`
3. Press ctrl+o: individual tool headers appear, each expandable
4. Press ctrl+o on the last tool in the expanded group: group re-collapses

- [ ] **Step 3: Verify single-tool runs are unaffected**

A run with only 1 tool should render exactly as before (no grouping).

- [ ] **Step 4: Verify failed tool breaks the group**

Trigger a run where one tool errors (e.g. `bash` returning exit code 1). The tools before the error should group normally; the failed tool renders on its own; tools after the failure group separately.
