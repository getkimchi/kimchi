> **Status:** Design proposal. Implementation is out of scope for the originating ferment — this document captures the target architecture for a future implementation workstream.

# Planning Modes Unification RFC — Tool-Centric Consolidation

## Motivation

The most concrete duplication between `--plan` and ferment is in the **tools** — both modes maintain their own tool catalog and their own tool visibility mechanism. These duplications impose real costs: tool availability decisions are made twice in two files, and two incompatible visibility primitives coexist without a clear layering contract.

**Three inline catalog definitions:**
- `PLAN_MODE_TOOLS` at `index.ts:82-93` — defines the `--plan` tool set
- `PLANNING_TOOL_NAMES` at `tool-scope.ts:18-48` — defines Ferment planning tools
- `IMPLEMENTATION_TOOL_NAMES` at `tool-scope.ts:50-84` — defines Ferment implementation tools

**Two visibility primitives:**
- Cooperative `ToolVisibilityAPI` (`planModeApplied`/`planModeHiddenTools` at `index.ts:203`) — used by `--plan`
- pi-mono `setActiveTools()` snapshot (`tool-scope.ts:97-130`) — used by Ferment

**A planned ad-hoc-to-ferment bridge:** The 3-option plan-complete dropdown (Execute / Rework / **Start as Ferment**) creates a natural migration path from adhoc planning to ferment. The shared tool catalog must support this transition — both `planning-adhoc` and `planning-ferment` profiles need enough shared tools (the "shared core") that the transition feels seamless.

The goal of this RFC is **not** to unify `--plan` and Ferment into a single workflow. Both UXs are valid and neither is deprecated. The goal is to consolidate the tool catalog and visibility mechanism so both modes share infrastructure, and to ensure the shared layer integrates cleanly with the planned 3-option dropdown.

---

## What Stays (Non-Goals)

This section explicitly lists what is **not** changed. These are invariants for the consolidation work.

- The `--plan` CLI flag remains a valid entry point. It enters a session-scoped, ephemeral, read-only planning context.
- Ferment remains a valid entry point. `/ferment new`, `propose_ferment_scoping`, and all ferment lifecycle tools remain as-is.
- Both FSMs continue to exist: `PermissionMode` (`index.ts:127-132`) governs the `--plan` session lifecycle; `FSM_STATES` (`src/extensions/ferment/fsm.ts:21-32`) governs the ferment lifecycle.
- The cooperative `ToolVisibilityAPI` (`planModeApplied`, `planModeHiddenTools` at `index.ts:203`) stays as a no-op fallback when the snapshot is active, preserving mid-turn third-party extension behavior via `pi.tweakTools()`.
- pi-mono's `setActiveTools()` snapshot is the canonical visibility primitive for both modes.
- Post-approval behavior for `--plan` (2-option dropdown today, 3-option with START_AS_FERMENT in the future at `index.ts:498`) stays as a UX-level decision.
- The ACP multi-session FIXME (`index.ts:367`) is out of scope for this work.
- The 3-option plan-complete dropdown (Execute / Rework / Start as Ferment) is a planned product feature and stays as a UX-level decision.

---

## Shared Tool Catalog

The tool catalog is the centerpiece of this consolidation. Rather than two separate inline definitions per mode, the catalog is structured as a **shared core + mode-specific extensions**.

### Structure

```typescript
type ToolProfile = "idle" | "planning-adhoc" | "planning-ferment" | "implementation-ferment" | "worker"

type ToolEntry = {
  name: string
  profiles: ToolProfile[]
  modes: ("adhoc" | "ferment" | "both")[]
}

// Shared core: tools available in both modes across most profiles
const SHARED_CORE_TOOLS: ToolEntry[] = [
  { name: "read",      profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "grep",      profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "find",      profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "ls",        profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "web_fetch", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "web_search",profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["both"] },
  { name: "list_ferments", profiles: ["idle"], modes: ["both"] },
]

// Adhoc-specific: tools only available in --plan mode
const ADHOC_MODE_TOOLS: ToolEntry[] = [
  { name: "questionnaire",         profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "update_todos",          profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "add_todo",              profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "mark_todo",             profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "clear_todos",           profiles: ["planning-adhoc"], modes: ["adhoc"] },
]

// Ferment-specific: tools only available in ferment mode
const FERMENT_MODE_TOOLS: ToolEntry[] = [
  { name: "propose_ferment_scoping",        profiles: ["planning-ferment"],              modes: ["ferment"] },
  { name: "scope_ferment",                  profiles: ["planning-ferment", "implementation-ferment"], modes: ["ferment"] },
  { name: "update_ferment_scope_field",     profiles: ["planning-ferment"],              modes: ["ferment"] },
  { name: "confirm_ferment_completion_criteria", profiles: ["planning-ferment"],         modes: ["ferment"] },
  { name: "ask_user",                       profiles: ["planning-ferment"],              modes: ["ferment"] },
  { name: "activate_ferment_phase",         profiles: ["planning-ferment"],              modes: ["ferment"] },
  { name: "set_phase",                      profiles: ["planning-ferment"],              modes: ["ferment"] },
  { name: "refine_ferment_phase",           profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "complete_ferment_phase",         profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "skip_ferment_phase",             profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "fail_ferment_phase",             profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "start_ferment_step",             profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "complete_ferment_step",          profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "verify_ferment_step",            profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "skip_ferment_step",              profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "fail_ferment_step",              profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "add_ferment_decision",           profiles: ["implementation-ferment"],        modes: ["ferment"] },
  { name: "add_ferment_memory",             profiles: ["implementation-ferment"],        modes: ["ferment"] },
]

// Write tools: available only in implementation-ferment
const WRITE_TOOLS: ToolEntry[] = [
  { name: "edit",                           profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "write",                          profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "Agent",                          profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "get_subagent_result",            profiles: ["implementation-ferment"], modes: ["ferment"] },
]
```

### Profile Derivation

The profile-to-tool-set mapping is derived by joining the appropriate arrays and filtering by profile membership:

```
SHARED_CORE_TOOLS + ADHOC_MODE_TOOLS  → planning-adhoc profile
SHARED_CORE_TOOLS + FERMENT_MODE_TOOLS → planning-ferment profile
SHARED_CORE_TOOLS + FERMENT_MODE_TOOLS + WRITE_TOOLS → implementation-ferment profile
```

This structure makes the boundary between shared and mode-specific explicit in the source. The `modes` field documents which UXs a tool belongs to; it is not used for enforcement.

### Pre-Unification Anchors

The three inline definitions being replaced:
- `PLAN_MODE_TOOLS` at `index.ts:82-93` — replaced by joining SHARED_CORE + ADHOC_MODE
- `PLANNING_TOOL_NAMES` at `tool-scope.ts:18-48` — replaced by joining SHARED_CORE + FERMENT_MODE (planning subset)
- `IMPLEMENTATION_TOOL_NAMES` at `tool-scope.ts:50-84` — replaced by joining SHARED_CORE + FERMENT_MODE + WRITE

---

## Shared Tool Visibility Mechanism

### Single Canonical Primitive: pi-mono `setActiveTools()` Snapshot

Both modes use the pi-mono `setActiveTools()` snapshot as the authoritative tool visibility mechanism:
- `--plan` mode: `applyPlanModeTools` at `index.ts:279-298` calls the shared `ToolProfileManager.apply(profile)`
- Ferment mode: `FermentToolScope.applyProfile` at `tool-scope.ts:97-130` calls the shared `ToolProfileManager.apply(profile)`

The shared `ToolProfileManager.apply(profile)` uses the snapshot primitive. It is the single call path for tool visibility changes in both modes.

### Cooperative API: No-Op Fallback

The cooperative `ToolVisibilityAPI` (`planModeApplied`, `planModeHiddenTools` at `index.ts:203`) is retained as a no-op fallback when the snapshot is active for the current turn. This preserves mid-turn third-party extension behavior via `pi.tweakTools()`.

### Layering Rule

The interaction between snapshot and cooperative votes follows this rule:
- When `setActiveTools()` has been called for the current turn, subsequent cooperative votes are **no-ops** (snapshot wins)
- When no snapshot is active (e.g., mid-turn third-party extension calls `pi.tweakTools()` before the FSM calls `apply`), cooperative votes apply normally
- At turn boundary (start of each new agent turn), both flags reset

This rule ensures the snapshot is authoritative for mode transitions while cooperative behavior is preserved for extensions that run before the FSM's turn-boundary call.

### Migration Path for Existing Calls

Both modes' existing profile-application functions are replaced with calls to `ToolProfileManager.apply(profile)`. The cooperative `planModeApplied`/`planModeHiddenTools` flags remain writable but become no-ops after the first snapshot call per turn.

---

## 3-Option Plan-Complete Dropdown Integration

The plan-complete dropdown at `index.ts:498` currently has 2 options (EXECUTE, DECLINE). The planned 3-option dropdown adds **START_AS_FERMENT**. This is a UX-level decision; the shared tool catalog does not decide when it appears.

### Behavior When User Picks "Start as Ferment"

1. The approved plan text is decomposed into a `planned` phase (one phase, one step per plan section) — this is the migration step.
2. A new ferment is created via the standard ferment lifecycle (`propose_ferment_scoping` / `scope_ferment` flow).
3. The session transitions from `--plan`'s `planning-adhoc` profile to Ferment's `implementation-ferment` profile.
4. The cooperative `tool_call` handler for `questionnaire` auto-promotion (`index.ts:595`) remains unchanged.

### How the Shared Catalog Supports This Transition

The `planning-adhoc` and `planning-ferment` profiles share the same core tools (read, grep, find, ls, web_fetch, web_search). This shared core ensures that navigation and discovery tools are available throughout the transition. The user experience is not disrupted by tool availability changes during the ad-hoc-to-ferment switch.

The START_AS_FERMENT option is a UX decision; the catalog's job is simply to ensure the two profiles have enough overlap that the transition feels seamless. No new catalog machinery is needed for this integration beyond the shared core structure.

### Plan Artifact Store Implications

The 3-option dropdown determines which `PlanArtifactStore` implementation is used:
- **EXECUTE**: `AdhocPlanStore.save()` (`index.ts:504`) → transition to auto/yolo mode
- **START_AS_FERMENT**: `FermentPlanStore.save()` (new ferment artifact via `.kimchi/ferments/<id>.json` at `state.ts:22-25`) → transition to ferment `implementation-ferment`

---

## Other Shared Components

The following components are secondary consolidation targets. They are less duplicative than the tool catalog and visibility mechanism, but consolidating them reduces the shared surface area between the two modes.

### Prompt Supplement Registry

Pre-unification anchors:
- `--plan` supplement: `extensions/permissions/prompts/plan-mode-supplement.ts`
- Ferment supplement: registered in the ferment extension's prompt block system

A registry API allows each mode to register prompt blocks. The composition of blocks (ordering, deduplication) stays per-mode. The registry is a lookup table, not a formatter.

### Entry Trigger Registry

A routing table maps each entry trigger to the FSM and initial state it activates:

| Trigger | Target FSM | Initial state |
|---------|-----------|---------------|
| `--plan` CLI flag | Permission FSM | `plan` |
| `shift+tab` cycling | Permission FSM | cycles `default → plan → auto → yolo` |
| `questionnaire` auto-promotion (`index.ts:595`) | Permission FSM | `plan` |
| `propose_ferment_scoping` | Ferment FSM | `DRAFT` |
| `/ferment new` | Ferment FSM | `DRAFT` |
| `KIMCHI_ACTIVE_FERMENT` env resumption (`state.ts:22-25`) | Ferment FSM | restored from `.kimchi/ferments/<id>.json` |

### Plan Artifact Store

```
interface PlanArtifactStore {
  save(plan: PlanText, mode: PlanningMode, id?: string): Promise<void>
  load(id: string, mode: PlanningMode): Promise<PlanText | null>
}

class AdhocPlanStore implements PlanArtifactStore {
  // Saves to .kimchi/plans/<timestamp>.md (index.ts:504)
}

class FermentPlanStore implements PlanArtifactStore {
  // Saves to .kimchi/ferments/<id>.json (state.ts:22-25)
}
```

---

## Consolidation Candidates

Ordered by priority (primary first):

1. **Tool profile catalog** — `PLAN_MODE_TOOLS` (`index.ts:82-93`), `PLANNING_TOOL_NAMES` (`tool-scope.ts:18-48`), `IMPLEMENTATION_TOOL_NAMES` (`tool-scope.ts:50-84`) become `SHARED_CORE_TOOLS`, `ADHOC_MODE_TOOLS`, `FERMENT_MODE_TOOLS`, `WRITE_TOOLS` in the shared catalog.

2. **Profile-application functions** — `applyPlanModeTools` (`index.ts:279-298`) and `FermentToolScope.applyProfile` (`tool-scope.ts:97-130`) become calls to `ToolProfileManager.apply(profile)`.

3. **3-option dropdown integration** — the START_AS_FERMENT path triggers `FermentPlanStore.save()` and transitions to `implementation-ferment` profile.

4. **Prompt Supplement Registry** — `planModeSupplement` (`index.ts:470-477`) and Ferment's prompt block both register against the same pi-mono hook.

5. **`hasActiveFerment` state queries** — `state.ts:60-66` is read by the permission layer (`index.ts:367`). This should be on the shared `PlanArtifactStore` interface.

6. **Plan artifact store** — adhoc save (`index.ts:504`) and ferment artifact load/save (`.kimchi/ferments/<id>.json`, `state.ts:22-25`) both implement `PlanArtifactStore`.

---

## Tradeoffs

### Tradeoff 1: Catalog Structure — Shared Core vs. Mode-Flavored Full Profiles

The user has picked shared core + mode-specific extensions. The key design question is where the boundary sits. The example catalog above treats `update_todos` as adhoc-specific and `propose_ferment_scoping` as ferment-specific. But `update_todos` could arguably belong in the shared core if Ferment users want to track todos mid-implementation. The implementer must draw this line explicitly.

### Tradeoff 2: Visibility Layering Rule — Snapshot Only vs. Snapshot + Cooperative No-Op

The layering rule (snapshot wins, cooperative is no-op after snapshot call) is the chosen design. The risk is that third-party extensions calling `pi.tweakTools()` after the snapshot is set may not see their tool changes take effect. This risk must be validated against real third-party extension behavior before shipping.

### Tradeoff 3: Where the Shared Catalog Lives — Top-Level, Permissions Extension, or Upstream

Three options:
- **Top-level `src/shared/planning/`**: Cleanest boundary, avoids circular dependencies
- **`src/extensions/permissions/`**: Smallest delta, but creates Ferment → permissions dependency
- **Upstream pi-mono**: Long-term ideal, requires upstream RFC and release cycle

For initial consolidation, top-level is preferred.

### Tradeoff 4: 3-Option Dropdown — Profile Transition Timing

When the user picks "Start as Ferment," is the profile switch to `implementation-ferment` instantaneous (same turn) or queued for the next turn? The turn-boundary snapshot constraint means instantaneous switches require calling `setActiveTools()` mid-turn, which may not be supported by pi-mono. If the switch is queued, the user sees a brief pause between plan approval and ferment activation. This must be validated.

### Tradeoff 5: ACP Multi-Session Compatibility

The current `hasActiveFerment` state (`state.ts:60-66`) is a single-active-ferment model. The ACP FIXME at `index.ts:367` documents that this is wrong for multi-session. The shared layer must be designed to accommodate a future event-bus redesign without breaking the permission layer's check. An event subscription model (`onActiveFermentChange`) accommodates ACP; a synchronous getter does not.

---

## Open Questions

Q1. **Catalog structure** — where is the exact boundary between shared core and mode-specific? For example, should `update_todos` belong to the shared core so Ferment users can track implementation todos, or does it stay adhoc-specific? The implementer must draw this line explicitly before the catalog is committed.

Q2. **Visibility layering rule** — what is the exact behavior when a third-party extension calls `pi.tweakTools()` after `setActiveTools()` has already been called for the current turn? Is the cooperative vote a no-op, or does it re-apply? Real third-party extension behavior must be validated before the layering rule is locked.

Q3. **Where the shared catalog lives** — top-level `src/shared/planning/`, `src/extensions/permissions/`, or upstream pi-mono? The top-level avoids circular dependencies, permissions is smallest delta, upstream is cleanest long-term. Which location is chosen determines the import graph and review boundary.

Q4. **3-option dropdown integration** — when the user picks "Start as Ferment," is the profile switch to `implementation-ferment` instantaneous or queued for the next turn? The turn-boundary snapshot constraint must be validated against pi-mono's actual mid-turn `setActiveTools()` support.

Q5. **ACP multi-session compatibility** — should the shared `PlanArtifactStore` use an event subscription model (`onActiveFermentChange`) or a synchronous getter for `hasActiveFerment`? A synchronous getter assumes one active ferment per session; the ACP FIXME at `index.ts:367` shows this assumption is wrong. Designing for ACP now avoids a future breaking change.

---

## Sequencing Recommendation

The consolidation should proceed in this order:

1. **Migrate the tool catalog first.** Replace the three inline definitions with `SHARED_CORE_TOOLS`, `ADHOC_MODE_TOOLS`, `FERMENT_MODE_TOOLS`, and `WRITE_TOOLS`. This is the highest-impact change and is relatively straightforward — it is a refactor, not a behavior change.

2. **Migrate the visibility mechanism second.** Replace `applyPlanModeTools` (`index.ts:279-298`) and `FermentToolScope.applyProfile` (`tool-scope.ts:97-130`) with `ToolProfileManager.apply(profile)`. The layering rule (snapshot wins, cooperative no-op after snapshot call) must be validated with real third-party extensions before shipping.

3. **Integrate the 3-option dropdown third.** Wire the START_AS_FERMENT path to `FermentPlanStore.save()` and the `implementation-ferment` profile switch. Validate that the profile transition timing (instantaneous vs. queued) matches user expectations.

4. **Migrate prompt supplements, entry triggers, and plan artifact store in any order.** These are lower-priority and have fewer interdependencies.

Throughout, validate that both UXs work as they do today after each migration step. Neither the `--plan` FSM nor the Ferment FSM is modified by the shared layer — they become callers of the shared infrastructure rather than owners of it.

The ACP multi-session problem (`index.ts:367`) is documented as a known constraint that must be accommodated in the shared layer design, but it is not resolved by this RFC. It remains a future workstream.