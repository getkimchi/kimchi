# Planning Modes in kimchi-code

Kimchi has two distinct planning modes with different entry points, tool visibility models, and lifecycle semantics. `--plan` permission mode is a lightweight, single-session planning context. Ferment planning mode is a persistent, multi-phase project planner backed by a JSON state file. Both restrict write tools during the planning phase but differ fundamentally in scope, persistence, and tool-swap mechanics.

---

## `--plan` permission mode

### Entry triggers

| Trigger | Location |
|---------|----------|
| CLI flag `--plan` on startup | `src/extensions/permissions/index.ts:160-162` |
| User cycles into plan mode via `shift+tab` (mode cycling) | `src/extensions/permissions/index.ts:330-336` (`changeMode` via `cycleMode`) |
| Auto-promotion: agent calls `questionnaire` tool in `default` mode | `src/extensions/permissions/index.ts:595` — `if (toolName === "questionnaire" && mode === "default") { changeMode(ctx, "default", "plan", "user") }` |
| Plan persona env var (`KIMCHI_AGENT_PERSONA=plan`) triggers path-scope enforcement on `write`/`edit` | `src/extensions/permissions/index.ts:518-534` |

The mode cycle order is defined at `src/extensions/permissions/index.ts:127-132` as `default → plan → auto → yolo → default`.

### Tool visibility

The allowed tool set is defined as `PLAN_MODE_TOOLS` at `src/extensions/permissions/index.ts:82-93`:

```
read, grep, find, ls, web_search, web_fetch,
questionnaire, bash (read-only only), update_todos,
add_todo, mark_todo, clear_todos
```

The set is also exposed as `PLAN_MODE_TOOL_SET` at `src/extensions/permissions/index.ts:96`.

**Application — apply on enter:**
`src/extensions/permissions/index.ts:279-286` — `applyPlanModeTools()` collects all active tools, filters through `isPlanModeTool`, and calls `planToolVisibility.disable(planModeHiddenTools)`. The `planModeApplied` flag (`index.ts:203`) prevents double-application.

**Restore on exit:**
`src/extensions/permissions/index.ts:290-298` — `restoreToolsFromPlanMode()` re-enables previously hidden tools when `changeMode(ctx, "plan", anything, ...)` fires.

**Run-time enforcement** (active in the `tool_call` handler regardless of visibility layer):
`src/extensions/permissions/index.ts:549-558` — `bash` is blocked unless `isReadOnlyBashCommand(command)` returns true; any tool not in `PLAN_MODE_TOOL_SET` and not marked read-only returns a block object with reason.

**Path-scope (separate from tool visibility — active only when `KIMCHI_AGENT_PERSONA=plan`):**
`src/extensions/permissions/index.ts:518-534` — `write` and `edit` are permitted only under `.kimchi/plans/`. `isWithinKimchiPlans(filePath, cwd)` resolves `..` and validates the prefix `ctx.cwd/.kimchi/plans/`.

### Prompt / system supplements

System prompt block registration at `src/extensions/permissions/index.ts:470-477`:

```typescript
blocks.register({
  id: "plan-mode-supplement",
  render: () => {
    if (getRuntimePermissionMode().mode !== "plan") return undefined
    return planModeSupplement.trim()
  },
})
```

The supplement text originates at `src/extensions/permissions/prompts/plan-mode-supplement.ts`. Key behaviors it injects:

1. Read-only posture: model is told it cannot edit/write/change state
2. Exploration-first guidance: explore files before planning; skip exploration for non-code tasks
3. Structured plan template with sections: Goal, Constraints, Chunks, Verification Strategy, Decision Log, Risks
4. **Completion markers** (on their own line): `<!-- PLAN_COMPLETE -->` or `<done>` — signals the system to show the approval menu
5. Assumption rule: every open assumption must be surfaced with `questionnaire` tool and resolved before PLAN_COMPLETE

### Lifecycle states

Plan mode is a **permission mode** (`PermissionMode = "default" | "plan" | "auto" | "yolo"`), not a separate FSM. It is toggled at runtime via `changeMode` and is not persisted as a session state.

- `plan` exits on: user approves the plan (`changeMode` to `auto` or `default`), or user declines (stays in plan mode)
- The status bar renders the current mode and `→ shift+tab` hint at `src/extensions/permissions/index.ts:300-305`

### UX behavior

1. **On plan mode enter**: `applyPlanModeTools()` hides all non-plan tools via the cooperative tool visibility layer; status bar shows `plan → shift+tab`
2. **During plan mode**: model operates in a read-only environment, following the structured plan template from `plan-mode-supplement.ts`
3. **On `questionnaire` call in default mode**: auto-promotes to plan mode at `index.ts:595`
4. **On `PLAN_COMPLETE` / `<done>` marker** in assistant message:
   - `turn_end` handler at `src/extensions/permissions/index.ts:485-511` intercepts the event
   - Shows a TUI dropdown: "Execute the plan" or "Rework the plan"
   - **Execute**: saves the approved plan to `.kimchi/plans/<timestamp>.md` via `saveApprovedPlan()` (`index.ts:504`), switches mode to `auto` (`index.ts:507`), then sends a `plan-execute` custom message via `pi.sendMessage` with `triggerTurn: true` (`index.ts:386-401` `executePlan`)
   - **Rework**: stays in plan mode
5. **Path-scope**: if `KIMCHI_AGENT_PERSONA=plan`, `write`/`edit` are restricted to `.kimchi/plans/*` even if the tool visibility layer would allow them

---

## Ferment planning mode

### Entry triggers (orient-interview-plan)

| Trigger | Location |
|---------|----------|
| `/ferment new` or `/ferment` (interactive) creates a draft ferment | `src/extensions/ferment/index.ts` — slash command handlers |
| `/ferment one-shot "task"` creates a draft ferment and auto-scopes | `src/extensions/ferment/oneshot.ts` |
| Headless: `KIMCHI_ACTIVE_FERMENT=<id>` env var on session start | `src/extensions/ferment/state.ts:22-25` (`getActiveFermentId`, `hasActiveFerment`) |
| Ferment status `draft` — agent calls `propose_ferment_scoping` | `src/extensions/ferment/tools/lifecycle.ts` |
| Agent calls `scope_ferment` — ferment transitions `draft → planned` | `src/extensions/ferment/tools/lifecycle.ts` |
| Tool profile `planning` is active while all phases have `status === "planned"` (no phase activated) | `src/extensions/ferment/tool-scope.ts:93-97` (`profileForFerment`) |

### Tool profiles

Tool profiles are pre-snapshotted at the start of each agent run via `pi.setActiveTools()` (pi-mono run-level snapshot model):
`src/extensions/ferment/tool-scope.ts:97-130` (`FermentToolScope.applyProfile`)

**`idle` profile** (no active ferment):
- All non-ferment tools visible
- Plus discovery tools: `list_ferments`, `request_ferment_workflow`
- All `PLANNER_ONLY_FERMENT_TOOL_NAMES` are hidden (`src/extensions/ferment/tool-names.ts:24-45`)

**`planning` profile** (ferment exists, all phases `status === "planned"`):
- `src/extensions/ferment/tool-scope.ts:18-48` (`PLANNING_TOOL_NAMES`):
  ```
  read, grep, find, ls, web_fetch, web_search,  // read-only discovery
  set_phase,                                     // phase tracker injected by ferment planner supplement
  propose_ferment_scoping, scope_ferment,
  update_ferment_scope_field, confirm_ferment_completion_criteria,
  list_ferments, ask_user,
  activate_ferment_phase                         // fires planning→implementation transition
  ```
- **Notable**: `bash`, `edit`, `write`, `Agent`, `get_subagent_result` are all hidden
- **Notable**: implementation lifecycle tools (e.g., `start_ferment_step`, `complete_ferment_phase`) are hidden — they become available on the next model turn after `activate_ferment_phase` succeeds (`tool-scope.ts:44-48`)

**`implementation` profile** (at least one phase `status !== "planned"`):
- `src/extensions/ferment/tool-scope.ts:50-84` (`IMPLEMENTATION_TOOL_NAMES`): union of `PLANNING_TOOL_NAMES` + `bash`, `edit`, `write`, `Agent`, `get_subagent_result` + all ferment lifecycle tools (`refine_ferment_phase`, `complete_ferment_phase`, `skip_phase`, `fail_phase`, `start_step`, `complete_step`, `verify_step`, `skip_step`, `fail_step`, `add_decision`, `add_memory`, `complete`)

**`worker` profile** (subagent, `KIMCHI_SUBAGENT=1`):
- Empty toolset — workers get tools from the agents manager, not from ferment

**Profile derivation** at `src/extensions/ferment/tool-scope.ts:89-99`:

```typescript
export function profileForFerment(ferment: Ferment | undefined): FermentToolProfile {
  if (isAgentWorker()) return "worker"
  if (!ferment) return "idle"
  const phases = ferment.phases ?? []
  const hasActivatedPhase = phases.some((phase) => phase.status !== "planned")
  return hasActivatedPhase ? "implementation" : "planning"
}
```

**Frozen states**: paused, complete, and abandoned ferments keep the profile they last had. A paused ferment that was never activated stays in `planning`; one that was running before pause stays in `implementation`.

### FSM states

Ferment has its own FSM defined at `src/ferment/fsm.ts:21-32` (`FSM_STATES` enum):

```
DRAFT → PLANNED → PHASE_ACTIVE → STEP_RUNNING → (back to PHASE_ACTIVE)
  ↓          ↓           ↓
ABANDONED  ABANDONED   PAUSED → PLANNED (when resuming with no active phase)
                              → PHASE_ACTIVE (when resuming with active phase)
                              ↘ COMPLETE (via complete_ferment or all phases terminal)
```

**FSM Events** at `src/ferment/fsm.ts:37-59` (`FSM_EVENTS` enum):
`SCOPE_FERMENT`, `ACTIVATE_PHASE`, `REFINE_PHASE`, `COMPLETE_PHASE`, `SKIP_PHASE`, `FAIL_PHASE`, `START_STEP`, `COMPLETE_STEP`, `VERIFY_STEP`, `SKIP_STEP`, `FAIL_STEP`, `PAUSE`, `RESUME`, `SET_STEP_GRADE`, `SET_PHASE_GRADE`, `SET_FERMENT_GRADE`, `ABANDON`

**Ferment domain statuses** (from `src/ferment/types.ts`):
`draft → planned → running → complete/paused/abandoned`

**FSM state mapping** at `src/ferment/fsm.ts:296-327`:
- `draft`/`scoping`/`planned` → `FSM_STATES.PLANNED` → domain status `planned`
- `PHASE_ACTIVE`/`STEP_RUNNING` → domain status `running`
- `PAUSED` → domain status `paused`
- `COMPLETE` → domain status `complete`
- `ABANDONED` → domain status `abandoned`

**Phase status**: `planned → active → completed / skipped / failed`

**Step status**: `pending → running → done / verified / skipped / failed` (failed steps can be recovered by starting again)

### Planning → implementation transition

The `planning` → `implementation` transition fires on the first successful `activate_ferment_phase` call. The FSM receives the `ACTIVATE_PHASE` event (`src/ferment/fsm.ts:37`), transitions the phase from `planned` to `active`, and the domain status shifts to `running`. On the next model turn, `profileForFerment` returns `"implementation"` and `applyProfile("implementation")` calls `pi.setActiveTools()` with the full toolset. This is observable in the step-1 notes at `src/extensions/ferment/tool-scope.ts:44-48` — the comment notes `activate_ferment_phase` is included in `PLANNING_TOOL_NAMES` despite triggering the transition. Full FSM transitions table: `src/ferment/fsm.ts:189-289`.

### UX behavior

1. **Creating a ferment** (`/ferment new`): agent calls `propose_ferment_scoping`, user confirms via `confirm_ferment_completion_criteria`, then `scope_ferment` saves the plan and transitions to `planned`; tool profile remains `planning`
2. **Planning phase**: model sees `planning` toolset. It reads files, drafts phases/steps, asks clarifying questions via `ask_user` or `questionnaire`. All write tools hidden.
3. **Activation**: model calls `activate_ferment_phase`. FSM transitions `planned → running`. On next model turn, `implementation` profile applies.
4. **Stuck-loop guard**: `start_ferment_step` called 3+ times without a `complete_ferment_step` blocks further starts and surfaces a recovery prompt (`src/extensions/ferment/state.ts` — `bumpStepStart`/`clearStepStart` with counter at `stepStartCounts`)
5. **Phase boundary**: depending on continuation policy (`manual`/`automated`):
   - `manual`: TUI dropdown shows "Proceed to Phase X" / "Pause here" / "Let me say something"
   - `automated`: no prompt, continues to next phase
6. **Dashboard**: always-visible widget above editor showing ferment name, phase/step progress with grades
7. **Continuation policy**: `/ferment auto` or `/ferment manual` switches at any time; `/ferment pause` persists state as `paused`; `/ferment resume` continues; `/ferment exit` clears active Ferment from session but keeps ferment file on disk

---

## Differences Summary

| Dimension | `--plan` Mode | Ferment Planning Mode |
|-----------|--------------|----------------------|
| **Entry** | CLI `--plan` flag; `shift+tab` cycle; auto-promote on `questionnaire` in default mode (`index.ts:595`) | `/ferment new` or headless `KIMCHI_ACTIVE_FERMENT` env var (`state.ts:22-25`); tool profile is `planning` while all phases are `planned` (`tool-scope.ts:93-97`) |
| **Tool visibility mechanism** | Cooperative `ToolVisibilityAPI.disable/enable` (additive per session) via `applyPlanModeTools`/`restoreToolsFromPlanMode` (`index.ts:279-298`) | pi-mono run-level snapshot via `pi.setActiveTools()` (pre-snapshotted at turn start) via `applyProfile` (`tool-scope.ts:100-130`) |
| **Tool set** | `PLAN_MODE_TOOLS` (`index.ts:82-93`): read, grep, find, ls, web_search, web_fetch, questionnaire, read-only bash, todo tools | `PLANNING_TOOL_NAMES` (`tool-scope.ts:18-48`): read, grep, find, ls, web_fetch, web_search, set_phase, propose_ferment_scoping, scope_ferment, update_ferment_scope_field, confirm_ferment_completion_criteria, list_ferments, ask_user, activate_ferment_phase |
| **Scope of planning** | Ad-hoc, single-session plan — user decides what to plan and when to approve | Multi-phase, multi-session project plan stored in `.kimchi/ferments/<uuid>.json`; phases/steps are first-class entities |
| **Approval UX** | TUI dropdown after `<!-- PLAN_COMPLETE -->` or `<done>` marker (`index.ts:485-511`): "Execute the plan" / "Rework the plan" | Phase-by-phase approval in `manual` policy; automatic in `automated` policy |
| **Post-approval behavior** | Switches to `auto` mode, sends `plan-execute` custom message (`index.ts:386-401`, `index.ts:507`) | Switches to `implementation` profile; `activate_ferment_phase` triggers phase-level FSM; execution can span many sessions |
| **Write access after approval** | Unrestricted — `auto` mode re-enables all tools via classifier | Implementation profile adds `bash`, `edit`, `write`, `Agent` (`tool-scope.ts:50-84`), still governed by normal permission rules |
| **Persistence** | Approved plan saved to `.kimchi/plans/<timestamp>.md` (best-effort); no long-term state | Authoritative state in `.kimchi/ferments/<uuid>.json`; survives restarts; full FSM with phases/steps |
| **Path-scope enforcement** | Separate `KIMCHI_AGENT_PERSONA=plan` flag restricts `write`/`edit` to `.kimchi/plans/` even after approval (`index.ts:518-534`) | No path-scope; write tools appear normally in `implementation` profile |
| **Profile switch trigger** | `changeMode` called at runtime (`index.ts:330-336`) | `profileForFerment` derived from `ferment.phases[].status`; `planning → implementation` fires on first `activate_ferment_phase` (`tool-scope.ts:89-99`) |