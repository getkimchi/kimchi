# Pi Config Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `~/.pi` with a tool-counter merged into the existing statusline footer, a subagent-widget extension, and specialist agent definitions.

**Architecture:** Two TypeScript extensions loaded by pi-mono from `~/.pi/agent/extensions/`. The statusline extension is modified in-place. The subagent-widget is a new file. Agent definitions are plain markdown files in `~/.pi/agent/agents/`. No build step — pi-mono loads `.ts` extensions directly at runtime via its built-in TypeScript loader.

**Tech Stack:** TypeScript, `@mariozechner/pi-coding-agent` ExtensionAPI, Node.js `child_process.spawn`, TypeBox schemas for tool parameters.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `~/.pi/agent/extensions/statusline.ts` | Add tool-counter tracking and tally line to existing footer |
| Create | `~/.pi/agent/extensions/subagent-widget.ts` | Subagent spawn/manage extension |
| Create | `~/.pi/agent/agents/scout.md` | Read-only recon agent definition |
| Create | `~/.pi/agent/agents/planner.md` | Planning agent definition |
| Create | `~/.pi/agent/agents/builder.md` | Implementation agent definition |
| Create | `~/.pi/agent/agents/reviewer.md` | Review-only agent definition |

---

## Task 1: Merge tool-counter into statusline.ts

Add per-tool call counts tracking and a fourth footer line showing `[Bash 3] [Read 7]`.

**Files:**
- Modify: `~/.pi/agent/extensions/statusline.ts`

- [ ] **Step 1: Add tool counts tracking at the top of the extension function**

In `statusline.ts`, after the existing `export default function (pi: ExtensionAPI) {` line, add a counts map and hook `tool_execution_end`. The counts reset per session start since the map is declared inside the function scope and re-initialised on `session_start`.

```typescript
export default function (pi: ExtensionAPI) {
  // ── Tool counts ───────────────────────────────────────────────────────────
  const counts: Record<string, number> = {}

  pi.on("tool_execution_end", async (event) => {
    counts[event.toolName] = (counts[event.toolName] ?? 0) + 1
  })
```

- [ ] **Step 2: Add a tally-rendering helper function**

Add this function inside the extension, below `progressBar()` and before `gitInfo()`:

```typescript
function toolTally(c: Record<string, number>): string {
  const entries = Object.entries(c)
  if (entries.length === 0) return gray("no tools called yet")
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => dim(`[${name} ${n}]`))
    .join(" ")
}
```

- [ ] **Step 3: Add tally line to the footer render**

In the `render(width: number): string[]` return, add `line4` after `line3`:

```typescript
// ── line 4: tool tally ─────────────────────────────────────────────
const line4 = toolTally(counts)

return [
  truncateToWidth(p1.join(sep), width),
  line2,
  truncateToWidth(line3, width),
  truncateToWidth(line4, width),
]
```

- [ ] **Step 4: Verify pi starts without errors**

```bash
pi --version
```

Expected: version string printed, no TypeScript errors.

- [ ] **Step 5: Smoke-test the footer**

Start pi in any directory, run a tool (e.g. ask it to read a file), confirm the 4th footer line updates with `[read 1]`.

- [ ] **Step 6: Commit**

```bash
cd ~/.pi
git add agent/extensions/statusline.ts
git commit -m "feat: add tool-counter tally line to statusline footer"
```

---

## Task 2: Create subagent-widget.ts

New extension that spawns background pi subagents and surfaces results as follow-up messages.

**Files:**
- Create: `~/.pi/agent/extensions/subagent-widget.ts`

- [ ] **Step 1: Create the file with imports and state**

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

interface Subagent {
  id: number
  task: string
  sessionFile: string
  status: "running" | "done" | "error"
  output: string
  pid: number | undefined
}

const SESSION_DIR = join(homedir(), ".pi", "agent", "subagent-sessions")
let nextId = 1
const agents: Map<number, Subagent> = new Map()

export default function (pi: ExtensionAPI) {
  mkdirSync(SESSION_DIR, { recursive: true })
```

- [ ] **Step 2: Add the spawn helper**

Add inside the export default function, before registering anything:

```typescript
  function spawnSubagent(task: string, sessionFile: string, ctx: ExtensionContext): Subagent {
    const id = nextId++
    const agent: Subagent = { id, task, sessionFile, status: "running", output: "", pid: undefined }
    agents.set(id, agent)

    // Resolve pi binary — same binary that launched this process
    const piBin = process.argv[0] === process.execPath ? process.execPath : "pi"

    const child = spawn(
      piBin,
      ["--mode", "json", "-p", "--no-extensions", "--session", sessionFile, task],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    agent.pid = child.pid

    let stdout = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { stdout += chunk.toString() })

    child.on("close", (code: number | null) => {
      agent.status = code === 0 ? "done" : "error"
      agent.output = stdout.trim()
      updateWidget(ctx)

      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `Subagent #${id} (${task.slice(0, 60)}) finished with status: ${agent.status}\n\n${agent.output}`,
          display: `Subagent #${id} done`,
        },
        { deliverAs: "followUp", triggerTurn: true },
      )
    })

    updateWidget(ctx)
    return agent
  }
```

- [ ] **Step 3: Add the widget renderer**

```typescript
  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return
    const lines = [...agents.values()].map((a) => {
      const icon = a.status === "running" ? "⟳" : a.status === "done" ? "✓" : "✗"
      return `${icon} #${a.id} ${a.task.slice(0, 50)}`
    })
    ctx.ui.setWidget("subagent-widget", lines.length > 0 ? lines : undefined)
  }
```

- [ ] **Step 4: Register the `/sub` command**

```typescript
  pi.registerCommand("sub", {
    description: "Spawn a background subagent: /sub <task>",
    handler: async (args, ctx) => {
      const task = args.trim()
      if (!task) { ctx.ui.notify("Usage: /sub <task>", "warning"); return }
      const sessionFile = join(SESSION_DIR, `sub-${Date.now()}.jsonl`)
      const agent = spawnSubagent(task, sessionFile, ctx)
      ctx.ui.notify(`Subagent #${agent.id} started`, "info")
    },
  })
```

- [ ] **Step 5: Register `/subcont`, `/subrm`, `/subclear` commands**

```typescript
  pi.registerCommand("subcont", {
    description: "Continue a subagent: /subcont <id> <prompt>",
    handler: async (args, ctx) => {
      const [idStr, ...rest] = args.trim().split(/\s+/)
      const id = parseInt(idStr)
      const prompt = rest.join(" ")
      const agent = agents.get(id)
      if (!agent) { ctx.ui.notify(`No subagent #${id}`, "error"); return }
      if (!prompt) { ctx.ui.notify("Usage: /subcont <id> <prompt>", "warning"); return }
      spawnSubagent(prompt, agent.sessionFile, ctx)
      ctx.ui.notify(`Subagent #${id} continued as new run`, "info")
    },
  })

  pi.registerCommand("subrm", {
    description: "Remove a subagent from the list: /subrm <id>",
    handler: async (args, _ctx) => {
      const id = parseInt(args.trim())
      agents.delete(id)
    },
  })

  pi.registerCommand("subclear", {
    description: "Clear all finished subagents",
    handler: async (_args, ctx) => {
      for (const [id, a] of agents) {
        if (a.status !== "running") agents.delete(id)
      }
      updateWidget(ctx)
    },
  })
```

- [ ] **Step 6: Register LLM-callable tools**

```typescript
  pi.registerTool({
    name: "subagent_create",
    label: "Create Subagent",
    description: "Spawn a background pi agent to handle a task asynchronously. Returns the subagent ID.",
    parameters: Type.Object({ task: Type.String({ description: "Task for the subagent to execute" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const sessionFile = join(SESSION_DIR, `sub-${Date.now()}.jsonl`)
      const agent = spawnSubagent(params.task, sessionFile, ctx)
      return { content: [{ type: "text", text: `Subagent #${agent.id} started` }] }
    },
  })

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all active and finished subagents with their status.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const rows = [...agents.values()].map(
        (a) => `#${a.id} [${a.status}] ${a.task.slice(0, 80)}`,
      )
      return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No subagents" }] }
    },
  })

  pi.registerTool({
    name: "subagent_continue",
    label: "Continue Subagent",
    description: "Continue an existing subagent session with a new prompt.",
    parameters: Type.Object({
      id: Type.Number({ description: "Subagent ID to continue" }),
      prompt: Type.String({ description: "Follow-up prompt" }),
    }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const agent = agents.get(params.id)
      if (!agent) return { content: [{ type: "text", text: `No subagent #${params.id}` }], isError: true }
      spawnSubagent(params.prompt, agent.sessionFile, ctx)
      return { content: [{ type: "text", text: `Subagent #${params.id} continued` }] }
    },
  })

  pi.registerTool({
    name: "subagent_remove",
    label: "Remove Subagent",
    description: "Remove a subagent entry from the list.",
    parameters: Type.Object({ id: Type.Number({ description: "Subagent ID to remove" }) }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      agents.delete(params.id)
      updateWidget(ctx)
      return { content: [{ type: "text", text: `Subagent #${params.id} removed` }] }
    },
  })
```

- [ ] **Step 7: Close the export default function and update widget on session start**

```typescript
  pi.on("session_start", async (_e, ctx) => {
    updateWidget(ctx)
  })
}
```

- [ ] **Step 8: Verify the extension loads**

```bash
pi --version
```

Expected: no errors.

- [ ] **Step 9: Smoke-test `/sub`**

Start pi, run `/sub list files in the current directory`. Verify:
- Widget appears with `⟳ #1 list files...`
- After completion, widget shows `✓ #1 list files...`
- A follow-up message appears in the chat with the result

- [ ] **Step 10: Commit**

```bash
cd ~/.pi
git add agent/extensions/subagent-widget.ts
git commit -m "feat: add subagent-widget extension with /sub commands and LLM tools"
```

---

## Task 3: Create specialist agent definitions

Four agent markdown files with frontmatter restricting tools and setting system prompts.

**Files:**
- Create: `~/.pi/agent/agents/scout.md`
- Create: `~/.pi/agent/agents/planner.md`
- Create: `~/.pi/agent/agents/builder.md`
- Create: `~/.pi/agent/agents/reviewer.md`

- [ ] **Step 1: Create `scout.md`**

```bash
mkdir -p ~/.pi/agent/agents
```

```markdown
---
name: scout
description: Read-only reconnaissance agent. Explores codebases, finds files, answers questions about structure. Never modifies anything.
tools: read,grep,find,ls
---

You are a scout agent. Your job is exploration and information gathering only.

Rules:
- NEVER write, edit, or delete files
- NEVER run bash commands that modify state
- Report findings clearly and concisely
- When done, summarize: what you found, where it is, what's relevant

Focus on facts, not opinions. Be thorough but fast.
```

- [ ] **Step 2: Create `planner.md`**

```markdown
---
name: planner
description: Planning agent. Reads code and produces numbered, step-by-step implementation plans. Never writes code.
tools: read,grep,find,ls
---

You are a planner agent. Your job is to produce implementation plans, not to implement them.

Rules:
- NEVER write, edit, or delete files
- Read and understand the codebase before planning
- Output a numbered list of concrete, actionable steps
- Each step must specify: what to do, which file, what the expected outcome is
- Flag risks, ambiguities, and dependencies explicitly

Your output should be a plan another agent can execute without needing to ask questions.
```

- [ ] **Step 3: Create `builder.md`**

```markdown
---
name: builder
description: Implementation agent. Reads plans and writes code. Follows instructions precisely.
tools: read,write,edit,bash,grep,find,ls
---

You are a builder agent. Your job is to implement exactly what is asked.

Rules:
- Follow the provided plan step by step
- Do not add features, refactor unrelated code, or make improvements beyond the task
- After each file change, verify it works (run tests if available)
- If you hit a blocker, stop and report it clearly — do not guess

Be precise. Be minimal. Ship what was asked.
```

- [ ] **Step 4: Create `reviewer.md`**

```markdown
---
name: reviewer
description: Code review agent. Reads diffs and code, produces structured review feedback. Never modifies files.
tools: read,bash,grep,find,ls
---

You are a reviewer agent. Your job is to review code and provide structured feedback.

Rules:
- NEVER write or edit files
- You may run read-only bash commands (git diff, git log, test runners)
- Structure your review as: Summary / Issues (critical/high/medium/low) / Suggestions
- Be specific: file path, line number, what the problem is, why it matters
- Call out security issues, logic bugs, and missing tests explicitly

Be direct. Good code review is not flattery.
```

- [ ] **Step 5: Commit**

```bash
cd ~/.pi
git add agent/agents/
git commit -m "feat: add scout, planner, builder, reviewer agent definitions"
```

---

## Self-Review

**Spec coverage:**
- ✓ Tool-counter merged into statusline (Task 1)
- ✓ Subagent-widget with `/sub`, `/subcont`, `/subrm`, `/subclear` commands (Task 2)
- ✓ LLM tools: subagent_create, subagent_list, subagent_continue, subagent_remove (Task 2)
- ✓ Agent definitions: scout, planner, builder, reviewer (Task 3)

**Placeholder scan:** None found. All code blocks are complete.

**Type consistency:**
- `Subagent` interface defined in Task 2 Step 1 and used consistently throughout Task 2
- `counts` map declared in Task 1 Step 1, `toolTally()` defined in Step 2, called in Step 3 — consistent
- `updateWidget(ctx)` defined in Task 2 Step 3, called in Steps 2, 5, 6, 7 — consistent

**Known limitation:** The `piBin` resolution in `spawnSubagent` (`process.argv[0] === process.execPath ? process.execPath : "pi"`) assumes `pi` is on PATH when running in dev mode. This is fine for the kimchi binary case and for normal pi installs.
