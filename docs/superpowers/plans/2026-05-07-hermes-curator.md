# Hermes Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the session-summary-based curator with a Hermes-faithful background consolidation loop: inline skill creation via tool description guidance + periodic subagent-driven consolidation triggered on session start.

**Architecture:** The skills-manager extension (already on `feature/skills-manager`) provides skill CRUD and usage tracking. A new `curator` extension owns state persistence (`.curator_state.json`), auto-transitions (pure computation + mutation), subagent-driven review, and a `curator` tool that the `/improve` skill invokes for manual runs.

**Tech Stack:** TypeScript, Node.js `child_process.spawn`, `yaml` (already in package.json), `proper-lockfile` (already in package.json), `vitest`

---

## File Map

**Cherry-picked from `feature/skills-manager` (Task 0):**
- `src/extensions/skills-manager/usage.ts` — UsageTracker, SkillState, UsageEntry, agentCreatedReport
- `src/extensions/skills-manager/skill-manager.ts` — SkillManager, validateName, parseSkill
- `src/extensions/skills-manager/tool.ts` — createSkillManageTool, SkillManageSchema
- `src/extensions/skills-manager/index.ts` — skillsManagerExtension
- `src/extensions/skills-manager/*.test.ts` — existing tests
- `src/extensions/improve/SKILL.md` — old content (to be replaced in Task 7)
- `src/extensions/improve/index.ts` — no-op extension (stays as-is)
- `src/extensions/subagent.ts` — exports `getSubagentInvocation`, `spawnSubagent`, `SubagentResult` added

**Created (new curator):**
- `src/extensions/curator/state.ts` — CuratorState type, loadState, saveState, shouldRunNow
- `src/extensions/curator/state.test.ts`
- `src/extensions/curator/transitions.ts` — computeTransitions (pure), runAutoTransitions (mutating)
- `src/extensions/curator/transitions.test.ts`
- `src/extensions/curator/review.ts` — buildCandidateList, buildCuratorPrompt, parseCuratorOutput, runCuratorReview
- `src/extensions/curator/review.test.ts`
- `src/extensions/curator/index.ts` — curatorExtension, maybeCurator, curator tool
- `src/extensions/curator/index.test.ts`

**Modified:**
- `src/extensions/skills-manager/tool.ts` — add Hermes inline creation guidance to description
- `src/extensions/improve/SKILL.md` — rewrite for Hermes consolidation (drop session-summary logic)
- `src/cli.ts` — import and register skillsManagerExtension, improveExtension, curatorExtension

---

## Task 0: Cherry-pick skills-manager + subagent exports

**Files:**
- Create: `src/extensions/skills-manager/` (all files)
- Create: `src/extensions/improve/` (all files)
- Modify: `src/extensions/subagent.ts` (export additions)

- [ ] **Step 1: Cherry-pick commits in order**

```bash
git cherry-pick 760a39b 0a6ab63 2a09136 d3f669c d182052 f58a9ed 2bc6aa5 5e24ee5 3d7a1d6 2bb80cd
```

Expected: 10 commits applied, no conflicts (these are from a sibling branch based on the same master).

- [ ] **Step 2: Verify files exist**

```bash
fd . src/extensions/skills-manager src/extensions/improve --type f | sort
```

Expected output includes:
```
src/extensions/skills-manager/index.ts
src/extensions/skills-manager/skill-manager.ts
src/extensions/skills-manager/tool.ts
src/extensions/skills-manager/usage.ts
src/extensions/improve/index.ts
src/extensions/improve/SKILL.md
```

- [ ] **Step 3: Verify subagent exports**

```bash
grep "export function getSubagentInvocation\|export function spawnSubagent\|export interface SubagentResult" src/extensions/subagent.ts
```

Expected: all three lines present.

- [ ] **Step 4: Run existing tests**

```bash
pnpm test --reporter=verbose 2>&1 | tail -20
```

Expected: all pre-existing tests pass.

---

## Task 1: Update skill_manage description for inline creation

**Files:**
- Modify: `src/extensions/skills-manager/tool.ts:74-77`

- [ ] **Step 1: Write the failing test**

In `src/extensions/skills-manager/tool.test.ts`, add to the existing describe block:

```typescript
it("description includes inline creation guidance", () => {
  const manager = new SkillManager("/tmp")
  const tracker = new UsageTracker("/tmp")
  const tool = createSkillManageTool(manager, tracker)
  expect(tool.description).toContain("Create when: complex task succeeded")
  expect(tool.description).toContain("Update when: instructions stale")
  expect(tool.description).toContain("Confirm with user before creating")
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/extensions/skills-manager/tool.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — description does not contain those strings yet.

- [ ] **Step 3: Replace description in tool.ts**

Open `src/extensions/skills-manager/tool.ts` and replace the `description` field:

```typescript
description:
  "Create, edit, patch, delete, list, and manage Kimchi skills.\n\n" +
  "Actions: create, edit, patch, delete, list (inventory), write_file, remove_file, pin.\n\n" +
  "## Inline skill creation guidance\n" +
  "Create when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.\n" +
  "Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use.\n" +
  "After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating or deleting.",
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/extensions/skills-manager/tool.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/skills-manager/tool.ts src/extensions/skills-manager/tool.test.ts
git commit -m "feat(skill_manage): add Hermes inline creation guidance to description"
```

---

## Task 2: CuratorState (state.ts + state.test.ts)

**Files:**
- Create: `src/extensions/curator/state.ts`
- Create: `src/extensions/curator/state.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/extensions/curator/state.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_CURATOR_STATE, loadState, saveState, shouldRunNow } from "./state.js"

describe("shouldRunNow", () => {
  it("returns false when paused", () => {
    const state = { ...DEFAULT_CURATOR_STATE, paused: true }
    expect(shouldRunNow(state, 3 * 3600)).toBe(false)
  })

  it("returns false when running and last_run_at < 4h ago", () => {
    const now = new Date("2026-05-07T12:00:00Z")
    const recentRun = new Date(now.getTime() - 1 * 3600 * 1000).toISOString()
    const state = { ...DEFAULT_CURATOR_STATE, running: true, last_run_at: recentRun }
    expect(shouldRunNow(state, 3 * 3600, now)).toBe(false)
  })

  it("clears stale lock when running and last_run_at > 4h ago", () => {
    const now = new Date("2026-05-07T12:00:00Z")
    const staleRun = new Date(now.getTime() - 5 * 3600 * 1000).toISOString()
    const state = { ...DEFAULT_CURATOR_STATE, running: true, last_run_at: staleRun }
    // Should NOT return false due to stale lock — falls through to other checks
    // With 7d interval: last_run_at 5h ago is within 7 days → returns false for interval
    expect(shouldRunNow(state, 3 * 3600, now)).toBe(false) // blocked by 7d interval
  })

  it("returns false when last_run_at is within 7 days", () => {
    const now = new Date("2026-05-07T12:00:00Z")
    const recentRun = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString()
    const state = { ...DEFAULT_CURATOR_STATE, last_run_at: recentRun }
    expect(shouldRunNow(state, 3 * 3600, now)).toBe(false)
  })

  it("returns false when idle < 2h", () => {
    expect(shouldRunNow(DEFAULT_CURATOR_STATE, 1 * 3600)).toBe(false)
  })

  it("returns true when all checks pass", () => {
    const now = new Date("2026-05-07T12:00:00Z")
    const oldRun = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString()
    const state = { ...DEFAULT_CURATOR_STATE, last_run_at: oldRun }
    expect(shouldRunNow(state, 3 * 3600, now)).toBe(true)
  })

  it("returns true when last_run_at is undefined (never run)", () => {
    expect(shouldRunNow(DEFAULT_CURATOR_STATE, 3 * 3600)).toBe(true)
  })
})

describe("loadState / saveState", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kimchi-curator-test-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns DEFAULT_CURATOR_STATE when file does not exist", async () => {
    const state = await loadState(join(tmpDir, ".curator_state.json"))
    expect(state).toEqual(DEFAULT_CURATOR_STATE)
  })

  it("round-trips state through save/load", async () => {
    const statePath = join(tmpDir, ".curator_state.json")
    const saved = {
      ...DEFAULT_CURATOR_STATE,
      last_run_at: "2026-05-07T10:00:00.000Z",
      run_count: 3,
      last_run_summary: "2 merged",
    }
    await saveState(statePath, saved)
    const loaded = await loadState(statePath)
    expect(loaded).toEqual(saved)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/extensions/curator/state.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement state.ts**

Create `src/extensions/curator/state.ts`:

```typescript
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface CuratorState {
  last_run_at?: string
  last_session_ended_at?: string
  run_count: number
  paused: boolean
  running: boolean
  last_run_summary?: string
}

export const DEFAULT_CURATOR_STATE: CuratorState = {
  run_count: 0,
  paused: false,
  running: false,
}

export async function loadState(statePath: string): Promise<CuratorState> {
  try {
    const raw = await readFile(statePath, "utf-8")
    return { ...DEFAULT_CURATOR_STATE, ...(JSON.parse(raw) as Partial<CuratorState>) }
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
      return { ...DEFAULT_CURATOR_STATE }
    }
    throw err
  }
}

export async function saveState(statePath: string, state: CuratorState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const tmp = `${statePath}.tmp.${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8")
  await rename(tmp, statePath)
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const TWO_HOURS_S = 2 * 3600

export function shouldRunNow(state: CuratorState, idleSeconds: number, now: Date = new Date()): boolean {
  if (state.paused) return false

  if (state.running) {
    if (!state.last_run_at) return false
    const lastRun = new Date(state.last_run_at)
    if (now.getTime() - lastRun.getTime() < FOUR_HOURS_MS) return false
    // Stale lock (crash assumed) — fall through
  }

  if (state.last_run_at) {
    const lastRun = new Date(state.last_run_at)
    if (now.getTime() - lastRun.getTime() < SEVEN_DAYS_MS) return false
  }

  if (idleSeconds < TWO_HOURS_S) return false

  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/extensions/curator/state.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/curator/state.ts src/extensions/curator/state.test.ts
git commit -m "feat(curator): add CuratorState with load/save/shouldRunNow"
```

---

## Task 3: Auto-transitions (transitions.ts + transitions.test.ts)

**Files:**
- Create: `src/extensions/curator/transitions.ts`
- Create: `src/extensions/curator/transitions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/extensions/curator/transitions.test.ts`:

```typescript
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UsageTracker } from "../skills-manager/usage.js"
import { computeTransitions, runAutoTransitions } from "./transitions.js"

describe("computeTransitions", () => {
  it("returns empty arrays when no entries provided", () => {
    const result = computeTransitions([], new Date())
    expect(result.proposeStale).toHaveLength(0)
    expect(result.proposeArchive).toHaveLength(0)
    expect(result.proposeReactivate).toHaveLength(0)
  })

  it("proposes stale for active skill with activity > 30d ago", () => {
    const now = new Date("2026-05-07T10:00:00Z")
    const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString()
    const entries = [
      { name: "old-skill", pinned: false, state: "active" as const, last_activity_at: thirtyFiveDaysAgo },
    ]
    const result = computeTransitions(entries, now)
    expect(result.proposeStale).toContain("old-skill")
  })

  it("proposes archive for skill with activity > 90d ago", () => {
    const now = new Date("2026-05-07T10:00:00Z")
    const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 3600 * 1000).toISOString()
    const entries = [
      { name: "ancient-skill", pinned: false, state: "active" as const, last_activity_at: ninetyFiveDaysAgo },
    ]
    const result = computeTransitions(entries, now)
    expect(result.proposeArchive).toContain("ancient-skill")
    expect(result.proposeStale).not.toContain("ancient-skill")
  })

  it("proposes reactivate for stale skill with activity <= 30d ago", () => {
    const now = new Date("2026-05-07T10:00:00Z")
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString()
    const entries = [
      { name: "returning-skill", pinned: false, state: "stale" as const, last_activity_at: tenDaysAgo },
    ]
    const result = computeTransitions(entries, now)
    expect(result.proposeReactivate).toContain("returning-skill")
  })

  it("never proposes transitions for pinned skills", () => {
    const now = new Date("2026-05-07T10:00:00Z")
    const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 3600 * 1000).toISOString()
    const entries = [
      { name: "pinned-skill", pinned: true, state: "active" as const, last_activity_at: ninetyFiveDaysAgo },
    ]
    const result = computeTransitions(entries, now)
    expect(result.proposeStale).not.toContain("pinned-skill")
    expect(result.proposeArchive).not.toContain("pinned-skill")
  })
})

describe("runAutoTransitions", () => {
  let tmpDir: string
  let tracker: UsageTracker

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kimchi-transitions-test-"))
    tracker = new UsageTracker(tmpDir)
    await tracker.bumpCreate("active-old-skill")
    await tracker.bumpCreate("stale-returning-skill")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("applies stale transition to .usage.json", async () => {
    const now = new Date("2026-05-07T10:00:00Z")
    const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString()

    // Manually set created_at to simulate old activity
    const usagePath = join(tmpDir, ".usage.json")
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(usagePath, "utf-8"))
    const usage = JSON.parse(raw)
    usage["active-old-skill"].created_at = thirtyFiveDaysAgo
    usage["active-old-skill"].last_used_at = undefined
    await import("node:fs/promises").then((fs) => fs.writeFile(usagePath, JSON.stringify(usage, null, 2)))

    await runAutoTransitions(tmpDir, now)

    const entry = await tracker.get("active-old-skill")
    expect(entry?.state).toBe("stale")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/extensions/curator/transitions.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement transitions.ts**

Create `src/extensions/curator/transitions.ts`:

```typescript
import type { AgentCreatedSkillReport, SkillState } from "../skills-manager/usage.js"
import { UsageTracker, agentCreatedReport } from "../skills-manager/usage.js"

const STALE_AFTER_DAYS = 30
const ARCHIVE_AFTER_DAYS = 90

export interface TransitionResult {
  proposeStale: string[]
  proposeArchive: string[]
  proposeReactivate: string[]
}

export function computeTransitions(entries: AgentCreatedSkillReport[], now: Date): TransitionResult {
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000)
  const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000)

  const result: TransitionResult = { proposeStale: [], proposeArchive: [], proposeReactivate: [] }

  for (const row of entries) {
    if (row.pinned) continue

    const anchor = row.last_activity_at
      ? new Date(row.last_activity_at)
      : row.created_at
        ? new Date(row.created_at)
        : now

    if (anchor <= archiveCutoff && row.state !== "archived") {
      result.proposeArchive.push(row.name)
    } else if (anchor <= staleCutoff && row.state === "active") {
      result.proposeStale.push(row.name)
    } else if (anchor > staleCutoff && row.state === "stale") {
      result.proposeReactivate.push(row.name)
    }
  }

  return result
}

export async function runAutoTransitions(skillsDir: string, now: Date = new Date()): Promise<TransitionResult> {
  const entries = await agentCreatedReport(skillsDir)
  const result = computeTransitions(entries, now)

  const tracker = new UsageTracker(skillsDir)
  const changes: { name: string; state: SkillState }[] = [
    ...result.proposeReactivate.map((name) => ({ name, state: "active" as const })),
    ...result.proposeStale.map((name) => ({ name, state: "stale" as const })),
    ...result.proposeArchive.map((name) => ({ name, state: "archived" as const })),
  ]

  if (changes.length > 0) {
    await tracker.setStateBatch(changes)
  }

  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/extensions/curator/transitions.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/curator/transitions.ts src/extensions/curator/transitions.test.ts
git commit -m "feat(curator): add computeTransitions + runAutoTransitions"
```

---

## Task 4: Review — prompt builder + YAML parser (review.ts partial + review.test.ts)

**Files:**
- Create: `src/extensions/curator/review.ts` (partial — prompt + parser only)
- Create: `src/extensions/curator/review.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/extensions/curator/review.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { buildCuratorPrompt, parseCuratorOutput } from "./review.js"

describe("buildCuratorPrompt", () => {
  it("includes candidate skill names in prompt", () => {
    const prompt = buildCuratorPrompt([
      { name: "git-workflow", description: "Git branching strategy", state: "active" },
      { name: "docker-build", description: "Build Docker images", state: "stale" },
    ])
    expect(prompt).toContain("git-workflow")
    expect(prompt).toContain("docker-build")
  })

  it("includes consolidation-only instruction", () => {
    const prompt = buildCuratorPrompt([])
    expect(prompt).toContain("consolidation")
    expect(prompt).toContain("agent_created")
  })

  it("lists available tools", () => {
    const prompt = buildCuratorPrompt([])
    expect(prompt).toContain("skill_manage")
    expect(prompt).toContain("skill_view")
    expect(prompt).toContain("skill_list")
  })

  it("includes required YAML output format", () => {
    const prompt = buildCuratorPrompt([])
    expect(prompt).toContain("consolidations:")
    expect(prompt).toContain("prunings:")
  })
})

describe("parseCuratorOutput", () => {
  it("parses valid YAML summary", () => {
    const text = `
I've reviewed the skills.

\`\`\`yaml
consolidations:
  - from: git-branch
    into: git-workflow
    reason: Both cover Git branching
prunings:
  - name: old-docker
    reason: Superseded by docker-workflow
\`\`\`
`
    const result = parseCuratorOutput(text)
    expect(result).not.toBeNull()
    expect(result?.consolidations).toHaveLength(1)
    expect(result?.consolidations[0].from).toBe("git-branch")
    expect(result?.consolidations[0].into).toBe("git-workflow")
    expect(result?.prunings).toHaveLength(1)
    expect(result?.prunings[0].name).toBe("old-docker")
  })

  it("handles output without markdown fences", () => {
    const text = `
consolidations:
  - from: skill-a
    into: skill-b
    reason: duplicate
prunings: []
`
    const result = parseCuratorOutput(text)
    expect(result).not.toBeNull()
    expect(result?.consolidations[0].from).toBe("skill-a")
  })

  it("returns null when no YAML structure found", () => {
    const result = parseCuratorOutput("I looked at the skills. Looks good!")
    expect(result).toBeNull()
  })

  it("returns empty arrays for missing sections", () => {
    const text = `
consolidations: []
prunings: []
`
    const result = parseCuratorOutput(text)
    expect(result?.consolidations).toHaveLength(0)
    expect(result?.prunings).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/extensions/curator/review.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement prompt builder + parser in review.ts**

Create `src/extensions/curator/review.ts`:

```typescript
import { parse as parseYaml } from "yaml"

export interface CuratorCandidate {
  name: string
  description: string
  state: string
}

export interface CuratorSummary {
  consolidations: Array<{ from: string; into: string; reason: string }>
  prunings: Array<{ name: string; reason: string }>
}

export function buildCuratorPrompt(candidates: CuratorCandidate[]): string {
  const candidateList =
    candidates.length === 0
      ? "(no agent-created skills to review)"
      : candidates.map((c) => `- ${c.name} [${c.state}]: ${c.description}`).join("\n")

  return `You are the Kimchi skill curator. Your job is **consolidation only** — not gap-finding, not creating new skills from scratch.

## Your scope

- **Agent-created skills only** — the candidate list below is pre-filtered. Bundled or harness skills are never touched.
- **No deletion** — only archive via \`skill_manage action=delete\` (archives are recoverable from .archive/).
- **Pinned skills are off-limits** — skip entirely.
- **Two consolidation strategies:**
  1. Merge into existing umbrella: patch it, archive siblings with \`absorbed_into\`
  2. Create new umbrella: \`skill_manage action=create\`, then archive absorbed skills

## Tools available

You have three tools: \`skill_manage\`, \`skill_view\`, \`skill_list\`. No terminal, no bash.

## Candidate skills (agent-created, capped at 40)

${candidateList}

## Instructions

1. Review the candidate list. Use \`skill_view\` to read any skill's full content before deciding.
2. Identify clusters of overlapping skills that can be consolidated under an umbrella.
3. Execute consolidations using \`skill_manage\`. When archiving a skill, set \`absorbed_into\` to the umbrella name.
4. After all tool calls are complete, output the structured summary below as your **final message**.

## Required output (emit after all tool calls)

\`\`\`yaml
consolidations:
  - from: <absorbed-skill-name>
    into: <umbrella-skill-name>
    reason: <one sentence>
prunings:
  - name: <archived-skill-name>
    reason: <one sentence>
\`\`\`

Every skill you archived must appear in exactly one list. If nothing was consolidated, output empty lists.`
}

export function parseCuratorOutput(text: string): CuratorSummary | null {
  // Strip markdown fences
  const stripped = text.replace(/```ya?ml\n?/g, "").replace(/```\n?/g, "")

  // Find the YAML structure starting from 'consolidations:' or 'prunings:'
  const match = stripped.match(/(consolidations\s*:[\s\S]*|prunings\s*:[\s\S]*)/)
  if (!match) return null

  try {
    const parsed = parseYaml(match[0]) as Partial<CuratorSummary>
    return {
      consolidations: Array.isArray(parsed.consolidations) ? parsed.consolidations : [],
      prunings: Array.isArray(parsed.prunings) ? parsed.prunings : [],
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/extensions/curator/review.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/curator/review.ts src/extensions/curator/review.test.ts
git commit -m "feat(curator): add buildCuratorPrompt + parseCuratorOutput"
```

---

## Task 5: runCuratorReview (complete review.ts)

**Files:**
- Modify: `src/extensions/curator/review.ts` (add candidate list builder + runCuratorReview)

No unit test for `runCuratorReview` — it spawns a subprocess; tested in Task 8 smoke test.

- [ ] **Step 1: Add readSkillDescription helper and buildCandidateList**

Append to `src/extensions/curator/review.ts`:

```typescript
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { buildSubagentArgs, getSubagentInvocation } from "../subagent.js"
import type { CuratorState } from "./state.js"
import { saveState } from "./state.js"
import type { SkillManager } from "../skills-manager/skill-manager.js"

async function readSkillDescription(skillPath: string): Promise<string> {
  try {
    const content = await readFile(join(skillPath, "SKILL.md"), "utf-8")
    // Extract 'description:' from frontmatter
    const match = content.match(/^description:\s*(.+)$/m)
    return match ? match[1].trim() : "(no description)"
  } catch {
    return "(unreadable)"
  }
}

export async function buildCandidateList(manager: SkillManager, cap = 40): Promise<CuratorCandidate[]> {
  const inventory = await manager.listInventory()
  const agentCreated = inventory.filter((s) => s.agent_created).slice(0, cap)

  return Promise.all(
    agentCreated.map(async (s) => ({
      name: s.name,
      description: await readSkillDescription(s.path),
      state: "active", // state from .usage.json if needed, good enough for prompt
    })),
  )
}

export interface RunCuratorReviewOptions {
  provider: string
  model: string
  statePath: string
  skillsDir: string
  manager: SkillManager
  background?: boolean
}

export async function runCuratorReview(opts: RunCuratorReviewOptions): Promise<CuratorSummary | null> {
  const { provider, model, statePath, skillsDir, manager, background = false } = opts

  // Mark as running
  const { loadState } = await import("./state.js")
  const state = await loadState(statePath)
  await saveState(statePath, { ...state, running: true })

  const candidates = await buildCandidateList(manager)
  const prompt = buildCuratorPrompt(candidates)

  const args = buildSubagentArgs({ provider, model, prompt }, [], collectExtensionArgs())
  const invocation = getSubagentInvocation(args)

  try {
    if (background) {
      // Fire-and-forget: update state when done
      const proc = spawn(invocation.command, invocation.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      })
      let output = ""
      proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
      proc.on("close", async () => {
        const summary = parseCuratorOutput(output)
        const current = await loadState(statePath)
        await saveState(statePath, {
          ...current,
          running: false,
          last_run_at: new Date().toISOString(),
          run_count: current.run_count + 1,
          last_run_summary: summary
            ? `${summary.consolidations.length} merged, ${summary.prunings.length} archived`
            : "completed (no structured output)",
        })
      })
      proc.on("error", async (err) => {
        const current = await loadState(statePath)
        await saveState(statePath, { ...current, running: false, last_run_summary: `error: ${err.message}` })
      })
      return null
    }

    // Foreground: wait for completion
    const { spawnSubagent } = await import("../subagent.js")
    const result = await spawnSubagent(invocation.command, invocation.args)
    const summary = parseCuratorOutput(result.accumulated)
    const current = await loadState(statePath)
    await saveState(statePath, {
      ...current,
      running: false,
      last_run_at: new Date().toISOString(),
      run_count: current.run_count + 1,
      last_run_summary: summary
        ? `${summary.consolidations.length} merged, ${summary.prunings.length} archived`
        : "completed (no structured output)",
    })
    return summary
  } catch (err) {
    const current = await loadState(statePath)
    await saveState(statePath, { ...current, running: false, last_run_summary: `error: ${String(err)}` })
    throw err
  }
}

function collectExtensionArgs(): string[] {
  const result: string[] = []
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "-e" || argv[i] === "--extension") && i + 1 < argv.length) {
      result.push("-e", argv[i + 1])
      i++
    } else if (argv[i].startsWith("--extension=")) {
      result.push("-e", argv[i].slice("--extension=".length))
    }
  }
  return result
}
```

- [ ] **Step 2: Verify existing review tests still pass**

```bash
pnpm test src/extensions/curator/review.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: all PASS (new code is additive only).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
pnpm build 2>&1 | tail -20
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/curator/review.ts
git commit -m "feat(curator): add buildCandidateList + runCuratorReview"
```

---

## Task 6: Extension wiring (index.ts + index.test.ts)

**Files:**
- Create: `src/extensions/curator/index.ts`
- Create: `src/extensions/curator/index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/extensions/curator/index.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CuratorState } from "./state.js"
import { DEFAULT_CURATOR_STATE, saveState } from "./state.js"
import { computeIdleSeconds, getStateFilePath } from "./index.js"

describe("getStateFilePath", () => {
  it("returns path inside skillsDir", () => {
    const path = getStateFilePath("/tmp/skills")
    expect(path).toBe("/tmp/skills/.curator_state.json")
  })
})

describe("computeIdleSeconds", () => {
  it("returns Infinity when last_session_ended_at is undefined", () => {
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE }
    const result = computeIdleSeconds(state, new Date("2026-05-07T12:00:00Z"))
    expect(result).toBe(Number.POSITIVE_INFINITY)
  })

  it("returns correct seconds since last session ended", () => {
    const now = new Date("2026-05-07T12:00:00Z")
    const twoHoursAgo = new Date(now.getTime() - 2 * 3600 * 1000).toISOString()
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE, last_session_ended_at: twoHoursAgo }
    const result = computeIdleSeconds(state, now)
    expect(result).toBeCloseTo(7200, -1) // within 10s
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/extensions/curator/index.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement index.ts**

Create `src/extensions/curator/index.ts`:

```typescript
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { SkillManager } from "../skills-manager/skill-manager.js"
import { UsageTracker } from "../skills-manager/usage.js"
import { loadState, saveState, shouldRunNow } from "./state.js"
import type { CuratorState } from "./state.js"
import { runAutoTransitions } from "./transitions.js"
import { runCuratorReview } from "./review.js"

export interface CuratorExtensionOptions {
  skillsDir?: string
  provider: string
  model: string
}

export function getStateFilePath(skillsDir: string): string {
  return join(skillsDir, ".curator_state.json")
}

export function computeIdleSeconds(state: CuratorState, now: Date): number {
  if (!state.last_session_ended_at) return Number.POSITIVE_INFINITY
  return (now.getTime() - new Date(state.last_session_ended_at).getTime()) / 1000
}

function getProviderModel(): { provider: string; model: string } | null {
  const argv = process.argv
  let provider: string | undefined
  let model: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider" && i + 1 < argv.length) provider = argv[++i]
    else if (argv[i] === "--model" && i + 1 < argv.length) model = argv[++i]
    else if (argv[i].startsWith("--provider=")) provider = argv[i].slice("--provider=".length)
    else if (argv[i].startsWith("--model=")) model = argv[i].slice("--model=".length)
  }
  if (provider && model) return { provider, model }
  return null
}

export default function curatorExtension(pi: ExtensionAPI, options?: CuratorExtensionOptions): void {
  const skillsDir = options?.skillsDir ?? join(homedir(), ".config", "kimchi", "harness", "skills")
  const statePath = getStateFilePath(skillsDir)
  const manager = new SkillManager(skillsDir)

  // Resolve provider/model: options > argv > skip (graceful no-op)
  const providerModel = options?.provider && options?.model
    ? { provider: options.provider, model: options.model }
    : getProviderModel()

  pi.on("session_start", async () => {
    const now = new Date()
    try {
      const state = await loadState(statePath)
      const idleSeconds = computeIdleSeconds(state, now)

      if (!shouldRunNow(state, idleSeconds, now)) return
      if (!providerModel) return // no model configured, skip silently

      // Non-blocking: don't await
      void (async () => {
        try {
          await runAutoTransitions(skillsDir, now)
          await runCuratorReview({
            provider: providerModel.provider,
            model: providerModel.model,
            statePath,
            skillsDir,
            manager,
            background: true,
          })
        } catch {
          // Swallow — never block session startup
        }
      })()
    } catch {
      // Swallow — never block session startup
    }
  })

  pi.on("session_shutdown", async () => {
    try {
      const state = await loadState(statePath)
      await saveState(statePath, { ...state, last_session_ended_at: new Date().toISOString() })
    } catch {
      // Best-effort
    }
  })

  // curator tool for /improve skill
  pi.registerTool({
    name: "curator",
    label: "Curator",
    description:
      "Run the skill curator review. action=run triggers a foreground consolidation pass on agent-created skills (bypasses the 7-day interval check). action=status returns the current curator state.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "status"] },
      },
      required: ["action"],
    } as never,

    async execute(_toolCallId: string, params: { action: "run" | "status" }) {
      if (params.action === "status") {
        const state = await loadState(statePath)
        return {
          content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
          details: state,
        }
      }

      if (!providerModel) {
        return {
          content: [{ type: "text" as const, text: "Curator: no provider/model configured. Pass --provider and --model when starting kimchi." }],
          details: null,
        }
      }

      // Check for active non-stale lock
      const state = await loadState(statePath)
      if (state.running && state.last_run_at) {
        const elapsedMs = Date.now() - new Date(state.last_run_at).getTime()
        if (elapsedMs < 4 * 60 * 60 * 1000) {
          return {
            content: [{ type: "text" as const, text: "Curator is currently running in the background. Check back later or run `curator action=status`." }],
            details: state,
          }
        }
      }

      try {
        await runAutoTransitions(skillsDir)
        const summary = await runCuratorReview({
          provider: providerModel.provider,
          model: providerModel.model,
          statePath,
          skillsDir,
          manager,
          background: false,
        })

        const text = summary
          ? `Curator complete.\n\nConsolidations (${summary.consolidations.length}):\n${summary.consolidations.map((c) => `  - ${c.from} → ${c.into}: ${c.reason}`).join("\n") || "  (none)"}\n\nArchived (${summary.prunings.length}):\n${summary.prunings.map((p) => `  - ${p.name}: ${p.reason}`).join("\n") || "  (none)"}`
          : "Curator complete. (no structured output received)"

        return {
          content: [{ type: "text" as const, text }],
          details: summary,
        }
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Curator failed: ${String(err)}` }],
          details: null,
          isError: true,
        }
      }
    },
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test src/extensions/curator/index.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: all PASS.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test --reporter=verbose 2>&1 | grep -E "PASS|FAIL|Error" | tail -20
```

Expected: no new failures.

- [ ] **Step 6: Commit**

```bash
git add src/extensions/curator/index.ts src/extensions/curator/index.test.ts
git commit -m "feat(curator): add curatorExtension with session hooks + curator tool"
```

---

## Task 7: Rewrite /improve SKILL.md

**Files:**
- Modify: `src/extensions/improve/SKILL.md`

- [ ] **Step 1: Replace SKILL.md content**

Overwrite `src/extensions/improve/SKILL.md`:

```markdown
---
name: improve
description: Run the curator — consolidate the agent-created skill library via umbrella-building
triggers:
  - user types "/improve"
  - user asks to "run self-improvement"
  - user asks to "consolidate skills"
  - user asks to "review the skill library"
category: harness
state: active
version: 2
---
# Skill Curator (/improve)

Use this skill when the user asks to run the self-improvement loop or consolidate skills.

## What the curator does

The curator consolidates **agent-created skills** — skills you created during sessions via `skill_manage action=create`. It does NOT touch bundled or harness skills. It does NOT delete anything — it archives (recoverable from `.archive/`).

## Step 1: Check curator status

Call `curator action=status` to check if a background run is in progress.

If the response shows `"running": true` with a recent `last_run_at` (< 4h ago), report:
> "The curator is currently running in the background. Check back later or wait for it to finish."

Then stop.

## Step 2: Confirm with user

Before running, confirm:
> "I'll review your agent-created skills and consolidate overlapping ones into umbrellas. No skills will be deleted — only archived (recoverable). Want to proceed? (Add 'dry-run' to preview without changes.)"

If the user says **dry-run**: call `skill_manage action=list` to show agent-created skills, describe what you'd consolidate, then stop without calling `curator action=run`.

## Step 3: Run the curator

Call `curator action=run`.

The curator will:
1. Apply auto-transitions (stale/reactivate/archive by age)
2. Spawn a consolidation subagent with access to skill_manage, skill_view, skill_list
3. Return a structured summary

## Step 4: Report results

Present the summary from the curator tool result:
- How many skills were consolidated (X → umbrella)
- How many were archived
- If nothing changed: "No consolidations found. Your skill library is already well-organized."
```

- [ ] **Step 2: Verify frontmatter is valid**

```bash
head -10 src/extensions/improve/SKILL.md
```

Expected: shows `---`, `name: improve`, etc.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/improve/SKILL.md
git commit -m "feat(improve): rewrite /improve skill for Hermes consolidation (drop session-summary logic)"
```

---

## Task 8: CLI wiring + smoke test

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing import check**

```bash
grep "skillsManagerExtension\|curatorExtension\|improveExtension" src/cli.ts
```

Expected: none of these lines exist yet.

- [ ] **Step 2: Add imports to cli.ts**

In `src/cli.ts`, after the existing imports section, add:

```typescript
import skillsManagerExtension from "./extensions/skills-manager/index.js"
import improveExtension from "./extensions/improve/index.js"
import curatorExtension from "./extensions/curator/index.js"
```

- [ ] **Step 3: Register extensions in the extensionFactories array**

In `src/cli.ts`, find the `extensionFactories` array (it lists extensions like `memoryExtension`, `webFetchExtension`, etc.) and add after `memoryExtension`:

```typescript
skillsManagerExtension,
improveExtension,
(pi: ExtensionAPI) => curatorExtension(pi),
```

Note: `curatorExtension` needs provider/model. Wrap it:

```typescript
// Inside the async main block, after providerModel is available from process.argv:
(pi: ExtensionAPI) => curatorExtension(pi),
```

Since `curatorExtension` reads provider/model from `process.argv` internally, no special wiring needed — just register it like the others.

- [ ] **Step 4: Build to verify no type errors**

```bash
pnpm build 2>&1 | tail -20
```

Expected: builds clean.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test 2>&1 | grep -E "passed|failed|Tests" | tail -5
```

Expected: all tests pass.

- [ ] **Step 6: Quick smoke test — verify curator tool is registered**

```bash
pnpm build:binary 2>&1 | tail -5
dist/bin/kimchi --help 2>&1 | head -5
```

Expected: binary builds and starts without errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat(curator): wire skillsManager + improve + curator extensions into CLI"
```

---

## Self-Review Checklist

After completing all tasks, verify spec coverage:

| Spec requirement | Task |
|---|---|
| Inline creation guidance in tool description | Task 1 |
| `.curator_state.json` with all fields | Task 2 |
| `shouldRunNow` with stale-lock timeout | Task 2 |
| `last_session_ended_at` for idle measurement | Task 2 + 6 |
| Auto-transitions (stale/archive/reactivate) with !pinned guard | Task 3 |
| Curator subagent prompt (consolidation-only, agent_created only) | Task 4 |
| YAML parser with fence stripping | Task 4 |
| Candidate list capped at 40 | Task 5 |
| Background spawn from session_start | Task 6 |
| 7d interval + 2h idle check | Task 6 (shouldRunNow) |
| session_shutdown writes last_session_ended_at | Task 6 |
| `/improve` checks running lock | Task 7 |
| `/improve` confirms before running | Task 7 |
| `/improve` calls same pipeline, no interval check | Task 7 + 6 |
| CLI registration | Task 8 |
| Old curator pipeline files dropped | Not applicable — they're only on feature/skills-manager, not cherry-picked |
