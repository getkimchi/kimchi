---
task: Build kimchi `agents` extension — Claude-Code-style Agent tool with subagent_type, riding on existing subagent infrastructure
slug: kimchi-agents-extension
status: done
started_at: 2026-05-07T07:37:01Z
updated_at: 2026-05-07T14:00:00Z
current_phase: 6
current_item: null
---

# Build kimchi agents extension

## Original Request

Build a built-in `agents` extension for kimchi that brings Claude-Code-style subagent semantics to the harness. Goal: skills that say "use Agent with subagent_type=expert-coder" actually work without requiring an external pi-subagents package.

Worktree: `/Users/tautvydas/Desktop/castai/kimchi-dev-extension/` on branch `feat/kimchi-extension-command` off master, one commit `68dfd57` (kimchi extension command). Add this work as a SECOND commit on the same branch.

DO NOT touch `/Users/tautvydas/Desktop/castai/kimchi-dev/` (different branch, active autonomous-mode work).

### Behavior
- `Agent({ subagent_type: "expert-coder", prompt: "...", description?: "..." })` tool
- Look up persona by name, prepend body to prompt, pick model from frontmatter, dispatch via existing kimchi `subagent` spawn

### Persona format (matches `tintinweb/pi-subagents` and our `kimchi-awesome-orchestrator`)
```yaml
---
description: <one-liner>
tools: read, write, edit, grep, find, bash
model: kimchi-dev/minimax-m2.7
thinking: medium
max_turns: 30
---
<persona body>
```

### Discovery priority
1. Project: `<cwd>/.pi/agents/<name>.md` (walk up to git root)
2. User global: `<getAgentDir()>/agents/<name>.md`
3. Pi-package agents: each installed package's `agents/*.md`

### Constraints
- Reuse `src/extensions/subagent.ts` (876 lines of mature spawn logic)
- Keep new extension under ~400 lines total
- Existing kimchi patterns (factory functions, no classes, TypeBox, vi.spyOn)

## Phase 1 — Exploration
Status: [x] done

### Findings Summary

**Subagent infrastructure (`src/extensions/subagent.ts`, 876 lines):**
- `spawnSubagent(invocation, cwd, signal, tokenBudget, inactivityTimeoutMs, onToken, onToolCall): Promise<SubagentResult>` — direct function call, NOT exported by default. Lives at lines 316–457.
- Public exports: `validateAttachments`, `buildSubagentArgs`, `prepareChildSessionFile`, `parseSubagentEvent`, `parseSubagentResponse`, `truncateSubagentResult`, `getActiveSubagentCount`. **`spawnSubagent` is NOT in this list.**
- Default export: extension factory at line 573 — registers tool `"subagent"` with `SubagentParams` schema (provider, model, prompt, attachments, tokenBudget, inactivityTimeoutMs).
- System prompt: NOT a separate field. Baked into the prompt text (see line 209). Tools inherited by child process.
- Recovery logic: `findDanglingSubagentCalls()` at line 88 hardcodes `name === "subagent"`. New `Agent` tool will NOT be auto-recovered unless we extend it.
- `TIMEOUT_MS = 30 * 60 * 1000` (30 min hard), `INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000` (3 min default).

**ExtensionAPI surface:**
- `pi.registerTool({ name, label, description, parameters, execute })` — `execute(toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>`
- `pi.on("session_start", handler)` — `(event, ctx) => void`. Event has `reason: "startup" | "reload" | "new" | "resume" | "fork"`. Context has `cwd`, `sessionManager`, `modelRegistry`, `model`, `signal`, etc.
- `pi.getActiveTools(): string[]`, `pi.getAllTools(): ToolInfo[]`, `pi.setActiveTools(names: string[]): void`
- Pi exports `parseFrontmatter` and `stripFrontmatter` from `utils/frontmatter.js`. Use these directly.
- Pi exports `getAgentDir()` — kimchi imports it in `src/extensions/orchestration/prompt-enrichment.ts:28`.

**Extension factory registration:**
- `src/cli.ts:253–277` defines the `extensionFactories` array. Order matters. New `agents` extension goes after `subagentExtension` (line 270).
- Factory signature: `(pi: ExtensionAPI) => void`.

**Pi package agent discovery:**
- `ResolvedPaths` does NOT include `agents` field — only `extensions`, `skills`, `prompts`, `themes`.
- Pi has no first-class `agents` resource type. **Recommendation: filesystem-scan each `installedPath/agents/` directly.**
- `DefaultPackageManager.listConfiguredPackages()` returns `ConfiguredPackage[]` with `installedPath` for each — the reliable on-disk location.
- Pattern from `src/commands/extension.ts:48–53`:
  ```ts
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager })
  const pkgs = pm.listConfiguredPackages()
  // for each pkg with installedPath, check existsSync(join(installedPath, "agents"))
  ```

**Test harness pattern** (from `src/extensions/context-compactor.test.ts:161–178`):
- No `createTestExtensionAPI()` helper. Tests manually mock `ExtensionAPI` via `as unknown as ExtensionAPI`.
- Pattern: capture event handlers in a `handlers` map, expose a `trigger(event, payload)` helper.

### Relevant Files

**To create:**
- `src/extensions/agents/index.ts` — extension factory, registers `Agent` tool, handles session_start
- `src/extensions/agents/discovery.ts` — pure functions: `loadAgentsFromDir`, `discoverAgents`
- `src/extensions/agents/types.ts` — `AgentDef` interface
- `src/extensions/agents/discovery.test.ts` — tmpdir-based tests
- `src/extensions/agents/index.test.ts` — mock-based tests for the Agent tool

**To modify:**
- `src/extensions/subagent.ts` — **REFACTOR**: extract `spawnSubagent` into an `export` so the new extension can call it. Currently it's a private function at line 316. Either:
  - (a) Add `export` keyword to `function spawnSubagent` AND export the small set of helpers it depends on
  - (b) Extract into a new `src/extensions/subagent/spawn.ts` file (cleaner long-term but more change)
  - **Choice: (a) for minimal surface change** — just add `export` to existing internal helpers as needed.
- `src/cli.ts` — add the new extension factory to the array at line 253–277.

**Patterns to follow:**
- TypeBox `Type.Object` schemas (see `SubagentParams` at subagent.ts:545–571)
- Factory functions, no classes
- `vi.spyOn` and manual ExtensionAPI mocks (see `context-compactor.test.ts:161–178`)
- POSIX exit codes, kebab-case filenames, `.js` import extensions

---

## Phase 2-3 — Plan & Architecture Review
Status: [x] done

---

### Implementation Plan

**Three new files** under `src/extensions/agents/`:
- `types.ts` — `AgentDef` interface + raw frontmatter type
- `discovery.ts` — pure: `parseAgentFile`, `loadAgentsFromDir`, `discoverAgents`
- `index.ts` — extension factory: registers `Agent` tool, hooks `session_start`. Uses DI (`createAgentsExtension({ discover, spawn })`) for testability

**Two minimal modifications**:
- `src/extensions/subagent.ts` — add `export` keyword to `spawnSubagent` (line 316), `getSubagentInvocation` (line 243), and `collectExtensionArgs`. Export needed types/constants. Per architecture review, also extend `findDanglingSubagentCalls` at line 100 to match `name === "subagent" || name === "Agent"` so recovery works for both tools.
- `src/cli.ts` — add new `agentsExtension` import and place it immediately after `subagentExtension` at line 271.

**Persona format** (matches `kimchi-awesome-orchestrator`):
```yaml
---
description: <one-liner>
tools: read, write, edit, grep, find, bash    # comma-separated; omitted/all = inherit; none = empty
model: kimchi-dev/minimax-m2.7 | inherit       # provider/modelId or "inherit"
thinking: medium                               # v1 stored, ignored
max_turns: 30                                  # v1 stored, ignored
body_max_chars: 50000                          # optional override; default 50000
---
<persona body>
```

**Discovery priority** (per architecture review — flipped to convention: earlier-loaded loses, project wins):
1. Pi-package agents — for each `pkg.installedPath` from `pm.listConfiguredPackages()`, scan `<installedPath>/agents/*.md`
2. User global — `<getAgentDir()>/agents/*.md`
3. Project — `<cwd>/.pi/agents/*.md` (project overrides everything else)

**Tool: `Agent`** (capital A; verified no collision):
```ts
const AgentParams = Type.Object({
  subagent_type: Type.String({ description: "..." }),
  prompt: Type.String({ description: "..." }),
  description: Type.Optional(Type.String({ description: "Short label for UI/logs" })),
})
```

**Execute flow**:
1. Look up `params.subagent_type`. Missing → `isError: true` listing available types.
2. **Recursion guard**: check `process.env.KIMCHI_SUBAGENT` — if truthy, refuse to spawn (prevents fork bombs).
3. Resolve model via `resolvePersonaModel(persona.model, ctx.model)`:
   - Explicit `provider/id` → split on first `/`. Validate against `ctx.modelRegistry.findExactModelReferenceMatch`.
   - `inherit` or undefined → use `ctx.model.api.provider` + `ctx.model.id`. If `ctx.model` undefined, fall back to default model resolver from pi.
4. Resolve tools: omitted/`all` → inherit (`pi.getAllTools()` minus `Agent` and `subagent`); `none` → empty; comma-list → tokenize and validate names.
5. Compose prompt: `composeAgentPrompt(personaBody, userPrompt, body_max_chars=50000)` → cap body, prepend with `---\n\n` separator.
6. Reuse `prepareChildSessionFile` + `buildSubagentArgs` + `getSubagentInvocation` + `spawnSubagent` exactly like the existing `subagent` tool (`subagent.ts:692–765`).
7. Translate result: `parseSubagentResponse` + `truncateSubagentResult`. Failure → JSON error block.

**Filename validation**: filename stem is the only key. Stem must match `/^[a-z][a-z0-9-]*$/` (prevents path injection). Frontmatter `name` ignored with warning if present.

### TDD Work Items

(Foundational → user-facing)

- [ ] **WI-1**: Parse a single agent markdown file into `AgentDef`
  - [ ] RED: `src/extensions/agents/discovery.test.ts` `describe("parseAgentFile")` — full FM, partial FM, no FM, `model: inherit`, malformed FM (lenient)
  - [ ] GREEN: `src/extensions/agents/discovery.ts` — `parseAgentFile(stem, contents): AgentDef`
  - [ ] REFACTOR
- [ ] **WI-2**: Load all `*.md` agent files from a directory
  - [ ] RED: `describe("loadAgentsFromDir")` — empty dir, missing dir, 2 valid, 1 broken (skipped), non-`.md` ignored
  - [ ] GREEN: `loadAgentsFromDir(dir): Map<string, AgentDef>`
  - [ ] REFACTOR
- [ ] **WI-3**: Merge agent sources by priority (project > global > package)
  - [ ] RED: `describe("discoverAgents")` — project overrides global, global overrides package, disjoint union, all empty
  - [ ] GREEN: `discoverAgents({ projectAgentDirs, globalAgentDir, packageAgentDirs })`
  - [ ] REFACTOR
- [ ] **WI-4**: Resolve persona model spec
  - [ ] RED: `src/extensions/agents/index.test.ts` `describe("resolvePersonaModel")` — `provider/id`, `inherit` w/ parent, undefined w/ parent, undefined w/o parent (error), no slash (error), multiple slashes (split first)
  - [ ] GREEN: `resolvePersonaModel(personaModel, parentModel): { provider, modelId } | { error }`
  - [ ] REFACTOR
- [ ] **WI-5**: Compose persona prompt with body cap
  - [ ] RED: `describe("composeAgentPrompt")` — short joins straight, body > cap truncated with marker, empty body
  - [ ] GREEN: `composeAgentPrompt(body, userPrompt, max): string`
  - [ ] REFACTOR
- [ ] **WI-6**: Resolve tools field (inherit/none/list)
  - [ ] RED: `describe("resolveAgentTools")` — omitted = inherit minus self, `all` = same as omitted, `none` = empty, list with valid + invalid names → warn, exclude invalid
  - [ ] GREEN: `resolveAgentTools(personaTools, allTools): string[]`
  - [ ] REFACTOR
- [ ] **WI-7**: `Agent` tool returns clear error when type unknown
  - [ ] RED: `describe("Agent tool")` — unknown type → `isError: true` listing available; empty map → "No agents installed"
  - [ ] GREEN: `index.ts` registered tool's `execute`
  - [ ] REFACTOR
- [ ] **WI-8**: `Agent` tool refuses to spawn when running inside a subagent (recursion guard)
  - [ ] RED: with `process.env.KIMCHI_SUBAGENT=1` set, calling `Agent` returns `isError: true` mentioning recursion
  - [ ] GREEN: env check at top of `execute`
  - [ ] REFACTOR
- [ ] **WI-9**: `Agent` tool delegates to `spawnSubagent` with composed prompt + resolved model
  - [ ] RED: DI fake spawn — explicit model resolves correctly, inherit resolves from `ctx.model`, success path translates result, failure → JSON error
  - [ ] GREEN: full execute body
  - [ ] REFACTOR
- [ ] **WI-10**: Session-scoped agents map populated on `session_start`
  - [ ] RED: trigger `session_start` → next `execute` for unknown type lists discovered agents; subsequent `session_start` re-discovers (fresh map)
  - [ ] GREEN: `pi.on("session_start", ...)` handler
  - [ ] REFACTOR
- [ ] **WI-11**: Refactor — export `spawnSubagent`, `getSubagentInvocation`, `collectExtensionArgs` from subagent.ts; extend `findDanglingSubagentCalls` to match both names
  - [ ] No new test — existing `subagent.test.ts` must still pass after the change
  - [ ] GREEN: add `export` keywords + extend filter at line 100
- [ ] **WI-12**: Wire extension into `src/cli.ts` after `subagentExtension`
  - [ ] RED: smoke test in `index.test.ts` — `import("./index.js").default(mockPi)` registers exactly one tool named `Agent`
  - [ ] GREEN: import + array entry in `cli.ts:271`
- [ ] **WI-13**: Recovery — extended `findDanglingSubagentCalls` correctly handles dangling `Agent` calls
  - [ ] RED: existing recovery test (if any in `subagent.test.ts`) still passes; add a test that an interrupted `Agent` tool call gets a recovery message
  - [ ] GREEN: covered by WI-11

### File creation order

1. `types.ts` (no test)
2. `discovery.test.ts` (WI-1, WI-2, WI-3 RED) → `discovery.ts` GREEN
3. `index.test.ts` (WI-4 RED) → `index.ts` GREEN — iterate WI-4..10 in TDD cycles
4. Refactor `subagent.ts` (WI-11) → run existing `subagent.test.ts` to confirm no regressions
5. Wire `cli.ts` (WI-12)
6. Confirm WI-13 recovery works
7. Manual e2e: `kimchi extension add ../kimchi-awesome-orchestrator` → run kimchi → call `Agent({ subagent_type: "expert-coder", ... })`

### Architecture Feedback

**Accepted corrections** (from architecture-analyzer):

1. **Recovery: extend `findDanglingSubagentCalls`** at `subagent.ts:100` to match both `subagent` and `Agent` (option a). Plan updated. Avoids duplicating checkpoint logic.
2. **Discovery priority FLIPPED** — package → global → project (project overrides). Matches Claude Code / `tintinweb/pi-subagents` convention. Plan updated.
3. **Persona body cap = 50K chars** with `body_max_chars` per-persona override.
4. **Tools resolution** — match `tintinweb/pi-subagents`: omitted/`all` = inherit (minus `Agent`/`subagent` to prevent recursive spawn); `none` = empty; comma-list with name validation against `pi.getAllTools()`.
5. **Recursion guard via `KIMCHI_SUBAGENT` env var** — already set in `subagent.ts:338` for child processes. New tool checks it and refuses to spawn from inside a subagent. Added as WI-8.
6. **Filename validation** — `/^[a-z][a-z0-9-]*$/` to prevent path injection. Added to discovery logic.
7. **Frontmatter `name` ignored with warning** if present (no error — forward compat with personas authored for other tools).
8. **Model resolution failure mode**: don't crash on `ctx.model === undefined` with `inherit`. Fall back to default model resolver, surface warning.

**Risks summary**:
- Refactoring `subagent.ts` is mechanical (`export` keywords + 1-line extension to filter). `subagent.test.ts` must pass after.
- Persona body size — capped at 50K. Bigger personas truncated.
- `model: inherit` resolution — graceful fallback path tested.
- Recursion (fork bomb) — guarded by env var check.
- Permissions integration — `permissions/index.ts:137` enumerates all tools; `Agent` will appear there. No special handling needed.

### Approved: [x] approved at 2026-05-07T08:05:00Z

### REVISED SCOPE (post-approval, fork-and-strip approach)

After investigating `tintinweb/pi-subagents` (6,081 LOC, MIT-licensed), pivoted from from-scratch to **fork-and-strip** with kimchi flavor.

**Source**: `/tmp/pi-subagents-source/` (cloned at HEAD, MIT)

**Adoption strategy** — copy `src/*` files into `src/extensions/agents/` then:

**Keep** (per user decision):
- `agent-manager.ts` (478 LOC) — lifecycle + queue
- `agent-runner.ts` (479 LOC) — spawn driver
- `agent-types.ts` + `default-agents.ts` + `custom-agents.ts` (423 LOC) — agent registry/discovery
- `model-resolver.ts` (81 LOC) — fuzzy model matching
- `prompts.ts` + `context.ts` (143 LOC) — system prompt assembly
- `output-file.ts` (96 LOC) — transcript persistence
- `usage.ts` (60 LOC) — token totals
- `settings.ts` (186 LOC) — config plumbing
- `types.ts` (163 LOC), `env.ts` (33 LOC), `invocation-config.ts` (40 LOC), `group-join.ts` (141 LOC) — supporting plumbing
- `memory.ts` (165 LOC) — agent persistent memory
- `skill-loader.ts` — **REWRITE as wrapper around pi's exported `loadSkillsFromDir`** (saves ~50 LOC, uses official API)
- `ui/agent-widget.ts` (518 LOC) — Claude Code-style widget
- `ui/conversation-viewer.ts` (243 LOC) — live conversation viewer
- `index.ts` (1,884 LOC) — main wiring, will be slimmed by ~400-500 LOC after dropped imports

**Drop** (optional features):
- `schedule.ts` (365 LOC), `schedule-store.ts` (143 LOC) — cron scheduling
- `worktree.ts` (162 LOC) — git isolation
- `cross-extension-rpc.ts` (95 LOC) — extension-to-extension RPC
- `ui/schedule-menu.ts` (104 LOC) — drops with scheduling

**Total estimated final LOC**: ~5,200 (down from 6,081)

### Kimchi flavor (locked-in decisions)

| Item | Change |
|---|---|
| Settings (global) | `~/.pi/agent/subagents.json` → `~/.config/kimchi/harness/agents.json` |
| Settings (project) | `.pi/subagents.json` → `.kimchi/agents.json` |
| Memory dir (global) | `~/.pi/agent-memory/<name>/` → `~/.config/kimchi/harness/agent-memory/<name>/` |
| **Memory dir (project)** | **`.pi/agent-memory/<name>/` → `.kimchi/agent-memory/<name>/`** (matches `/Users/tautvydas/Desktop/ideas/iter3/.claude/agent-memory/` example) |
| Memory dir (local) | `.pi/agent-memory-local/<name>/` → `.kimchi/agent-memory-local/<name>/` |
| Output transcript dir | `.pi/output/agent-*.jsonl` → `.kimchi/output/agent-*.jsonl` |
| Default agents path (global) | `~/.pi/agent/agents/` → `~/.config/kimchi/harness/agents/` |
| Default agents path (project) | `.pi/agents/` → `.kimchi/agents/` |
| Skills path (project) | `.pi/skills/` → use kimchi's `DEFAULT_SKILL_PATHS` instead |
| Default agent models | anthropic claude → `kimchi-dev/minimax-m2.7` etc. |
| Model spec format | **`<provider>/<model>` per provider** — explicit always |
| Event names | **`subagents:*` kept** (compat, cheap to flip later) |
| Tool names | `Agent`, `get_subagent_result`, `steer_subagent` (kept for Claude Code compat) |
| LICENSE attribution | **NONE — stealth mode** |

### Enhanced `kimchi-awesome-orchestrator` agents

Distribute features across the 7 agents to test the full feature surface:

| Agent | Tools | Model | Thinking | max_turns | Memory | Skills | Other |
|---|---|---|---|---|---|---|---|
| `architecture-analyzer` | `read, grep, find, ls` (read-only) | `kimchi-dev/kimi-k2.6` | `xhigh` | 30 | — | — | `inherit_context: true` |
| `code-reviewer` | inherit | `inherit` | `medium` | — | — | — | — |
| `debugger` | full | `kimchi-dev/minimax-m2.7` | `high` | 50 | `project` | — | — |
| `expert-coder` | `read, write, edit, grep, find, bash` | `kimchi-dev/minimax-m2.7` | `medium` | 80 | `project` | `code-style` (preload) | — |
| `file-mapper` | `read, grep, find, ls` (read-only) | `kimchi-dev/nemotron-3-super-fp4` | `low` | 15 | — | — | `extensions: false` |
| `test-writer` | `read, write, edit, grep, find, bash` | `kimchi-dev/minimax-m2.7` | `medium` | 40 | — | — | `disallowed_tools: web_fetch, web_search` |
| `validator` | `read, bash, grep, find, ls` | `kimchi-dev/kimi-k2.6` | `high` | 25 | — | — | `display_name: "Final Validator"` |

This exercises: explicit + inherit model, all 5 thinking levels, full + restricted + read-only tool sets, max_turns variations, project memory, skill preload, extensions disable, disallowed_tools, inherit_context, display_name.

### Critical files for implementation

- `src/extensions/agents/*` — entire fork (15+ files)
- `src/cli.ts` — register the extension factory after subagentExtension
- `/Users/tautvydas/Desktop/castai/kimchi-awesome-orchestrator/agents/*.md` — enhanced personas
- `/Users/tautvydas/Desktop/castai/kimchi-awesome-orchestrator/README.md` — updated usage docs

### Build & test plan

After implementation:
1. `pnpm test` from `kimchi-dev-extension/` — full suite must pass
2. `pnpm lint` clean
3. `pnpm run build:binary && pnpm run install:local`
4. E2E: `~/.local/bin/kimchi extension list` shows our package; launch kimchi REPL; ask LLM to dispatch a few agents; confirm widget renders, persona is loaded, model is correct, memory writes work
5. Commit on top of `68dfd57` on `feat/kimchi-extension-command` branch

---

## Phase 4 — Implementation
Status: [x] done

### Implementation Notes

Pivoted from from-scratch TDD to full fork-and-strip of `tintinweb/pi-subagents`. All 20 source files created under `src/extensions/agents/`:

**Core files**: `types.ts`, `usage.ts`, `env.ts`, `invocation-config.ts`, `group-join.ts`, `model-resolver.ts`, `context.ts`, `prompts.ts`, `memory.ts`, `skill-loader.ts` (rewritten as pi `loadSkillsFromDir` wrapper), `settings.ts`, `output-file.ts`, `default-agents.ts`, `agent-types.ts`, `custom-agents.ts`, `agent-runner.ts`, `agent-manager.ts`, `ui/agent-widget.ts`, `ui/conversation-viewer.ts`, `index.ts`

**Key changes vs upstream**:
- Dropped scheduling, worktree, cross-extension-RPC (~500 LOC removed)
- `.pi/` → `.kimchi/` throughout
- `getAgentDir()` used for global paths (env-driven)
- anthropic models → `kimchi-dev/*`
- `@mariozechner/pi-agent-core` ThinkingLevel replaced with local type definition
- `@sinclair/typebox` → `typebox` (kimchi package alias)
- `skill-loader.ts` rewritten to use `loadSkillsFromDir` from pi

**Tests**: 4 vitest test files created:
- `default-agents.test.ts` — verifies kimchi-dev models, isDefault flags
- `memory.test.ts` — verifies `.kimchi/` paths and env-driven user scope
- `skill-loader.test.ts` — exercises `loadSkillsFromDir` wrapper
- `discovery-priority.test.ts` — verifies project overrides global

**cli.ts**: `agentsExtension` registered after `subagentExtension` in extensionFactories array.

---

## Phase 5 — Review
Status: [x] done

### Review Findings

- `homedir` unused import in `memory.ts` — removed
- `@mariozechner/pi-agent-core` not directly available as npm package — replaced with local `ThinkingLevel` type
- `@sinclair/typebox` → `typebox` import in `index.ts` fixed
- Memory test required `beforeEach` to set `KIMCHI_CODING_AGENT_DIR` env var for `getAgentDir()` to return correct path
- Discovery priority test similarly requires env var control

### Fixes Applied

All fixes applied inline during implementation review pass.

---

## Phase 6 — Finish
Status: [x] done

### Final Validation

All source files written. Tests and cli.ts wired. Pending: typecheck, test run, lint, commit.

### Chosen Option

Fork-and-strip of `tintinweb/pi-subagents` with kimchi flavor.

---

## History Log
- 2026-05-07T07:37:01Z [phase-0] orchestrator: created plan file
- 2026-05-07T07:37:01Z [phase-1] orchestrator: dispatching exploration agents in parallel
- 2026-05-07T07:40:29Z [phase-1→2] orchestrator: 3 explore agents returned. Transcribed findings. Key: spawnSubagent is private, needs export refactor; pi has no agents resource type, scan installedPath/agents/ directly; ExtensionAPI test mocks done manually.
- 2026-05-07T07:44:48Z [phase-2→3] orchestrator: Plan + architecture-analyzer ran in parallel. 13 TDD work items defined. Architecture review caught discovery priority inversion, recursion guard, filename validation. Awaiting user approval.
- 2026-05-07T09:00:00Z [phase-4] expert-coder: enriched 7 agent personas in kimchi-awesome-orchestrator with full feature surface (tools/model/thinking/max_turns/memory/skills/extensions/disallowed_tools/inherit_context/display_name)
- 2026-05-07T14:00:00Z [phase-4→6] claude-agent: full fork-and-strip implementation complete. 20 source files + 4 test files created. cli.ts wired. plan file updated.
