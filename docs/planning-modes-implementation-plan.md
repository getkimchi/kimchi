# Planning Modes Implementation Plan

> **Status:** Executable plan. Follows from `docs/planning-modes-unification-rfc.md`. Implementation sequenced into 4 phases. Both UXs preserved. Oneshot ferment uses the same planning path with judge-routed interactive tools.

---

## Overview

This plan operationalizes the unification RFC. Each phase replaces a specific duplication (inline catalog, dual visibility primitive, 2-option dropdown, scattered registries) with a shared module under `src/shared/planning/`. Both `--plan` and ferment UXs (interactive and oneshot) remain unchanged from the user's perspective — each phase validates that both UXs work as before via unit, integration, and TUI e2e tests.

A key product reality: **tool names differ between modes even when the underlying operation is similar** (e.g., `questionnaire` in `--plan` vs `ask_user` in ferment). The catalog and transitions explicitly handle these name differences. **Oneshot ferment** follows the same planning path as interactive ferment but routes interactive tools through a judge model instead of a human.

## Conventions

- **Phases numbered 1–4**; each has a goal, pre-conditions, steps, phase verify command, and gates.
- **Steps** have: Scope (files), Action (imperative), Verify (concrete shell command), Accept when (observable condition).
- **Test files** co-located as `*.test.ts` beside source files (kimchi-dev convention).
- **TUI e2e tests** live in `tests/e2e/tui/`.
- **Re-exports** preserve old function names until a follow-on removal.
- **Tool name mapping** is the source of truth for which tool name applies in which mode — see `docs/tool-name-mapping.md` (produced in Phase 1, Step 0).

---

## Cross-Phase: Tool Name Mapping

A reference doc `docs/tool-name-mapping.md` is produced in **Phase 1, Step 0** and consulted by every subsequent phase. It enumerates:

| Concept | `--plan` name | Ferment name | Oneshot behavior | Notes |
|---------|---------------|--------------|------------------|-------|
| Ask user structured question | `questionnaire` | `ask_user` | `ask_user` (judge-routed) | Both render the shared `extensions/questionnaire-form.ts` UI; differ only in tool name and header content. Oneshot routes to judge model. |
| Confirm scope completion | (none) | `confirm_ferment_completion_criteria` | Same tool, judge-routed | Ferment-specific. Oneshot routes to judge model. |
| Update task list / phase tracker | `update_todos`, `add_todo`, `mark_todo`, `clear_todos` | `set_phase` | `set_phase` | Different conceptual operation; both modes have a tracker |
| Read-only shell access | `bash` (gated to read-only at `index.ts:549-558`) | (hidden in `planning-ferment`) | (hidden in `planning-ferment`) | Bash policy differs: `--plan` admits read-only bash with runtime gate; ferment omits bash entirely from planning profile |
| Scope creation | (none) | `propose_ferment_scoping`, `scope_ferment`, `update_ferment_scope_field` | Same | Ferment-specific |
| Lifecycle transition | (none — mode-switch only) | `activate_ferment_phase`, `refine_ferment_phase`, `complete_ferment_phase`, `complete_ferment_step`, … | Same | Ferment-specific |

This mapping is the authoritative reference for the catalog and for tool-swap behavior during the Start as Ferment transition.

---

## Cross-Phase: Oneshot Mode Considerations

Oneshot ferment mode (via `/ferment one-shot` or `--ferment-oneshot`) follows the same planning path as interactive ferment — same catalog, same visibility mechanism, same lifecycle tools. The differences are runtime-routing, not catalog-level:

| Concern | Interactive ferment | Oneshot ferment |
|---------|--------------------|-----------------|
| Catalog mode-flavor | `ferment` | `ferment` (same) |
| Profile sequence | `planning-ferment` → `implementation-ferment` → `implementation-ferment` | Same |
| `ask_user` behavior | Routes to TUI for human input (`src/extensions/ferment/prompt-ui.ts`) | Routes to judge model (`src/extensions/ferment/judge.ts`) |
| `confirm_ferment_completion_criteria` behavior | Routes to TUI for human input | Routes to judge model |
| 3-option plan-complete dropdown | Applies (interactive agent) | **Not applicable** — oneshot starts in ferment mode already |
| Discovery tools (`read`, `grep`, etc.) | Available | Available |
| Execution tools (`bash`, `edit`, etc.) | Available after `activate_ferment_phase` | Available after `activate_ferment_phase` |

**Implications for the plan:**

1. **No new mode-flavor in the catalog.** The `ferment` flavor covers both interactive and oneshot. The catalog declares tool names; runtime routing differentiates interactive vs judge behavior (handled in `src/extensions/ferment/ask-user.ts`).
2. **The 3-option dropdown (Phase 3) only applies to interactive sessions.** Oneshot starts in ferment mode directly via `/ferment one-shot` or `--ferment-oneshot`; no ad-hoc-to-ferment promotion is needed.
3. **The tool name mapping doc must include a "routing" column** for `ask_user` and `confirm_ferment_completion_criteria` indicating judge-routed in oneshot, TUI-routed in interactive.
4. **Phases 1 and 2 apply uniformly** to both interactive and oneshot ferment. Phase 3 explicitly excludes oneshot from the dropdown changes.

---

## Phase 1: Shared Tool Catalog

### Goal
Replace 3 inline tool catalog definitions with a single shared catalog at `src/shared/planning/tool-catalog.ts`. The catalog is mode-flavored: shared core + mode-specific entries with explicit tool names per mode. Oneshot ferment uses the same `ferment` flavor as interactive ferment; runtime routing differentiates.

### Pre-conditions
- RFC is the design authority (`docs/planning-modes-unification-rfc.md`).
- Both UXs (interactive and oneshot) work as today (existing test suites pass).
- `src/shared/planning/` does not exist yet.

### Steps

**0. Audit tool name differences.** Produce `docs/tool-name-mapping.md` with the table above and any additional differences found by grepping `src/extensions/permissions/` and `src/extensions/ferment/` for tool-name string literals. Include routing column for user-facing tools.
- Verify: `test -f docs/tool-name-mapping.md && grep -cE '^\| ' docs/tool-name-mapping.md | awk '{exit !($1 >= 6)}' && grep -c 'judge-routed\|judge model' docs/tool-name-mapping.md | awk '{exit !($1 >= 2)}'`
- Accept when: The doc enumerates at least the rows in the cross-phase table above, plus any additional differences found.

**1. Create shared catalog module.** Define `ToolProfile`, `ToolEntry`, and the four arrays plus `getToolsForProfile(profile, mode)` derivation function.
- Verify: `test -f src/shared/planning/tool-catalog.ts && grep -c 'SHARED_CORE_TOOLS\|ADHOC_MODE_TOOLS\|FERMENT_MODE_TOOLS\|WRITE_TOOLS' src/shared/planning/tool-catalog.ts`
- Accept when: Module exports the four arrays and the derivation function with documented types.

Example shape (illustrative):

```typescript
type ToolProfile = "idle" | "planning-adhoc" | "planning-ferment" | "implementation-ferment" | "worker"

type ToolEntry = {
  name: string                              // the actual tool name as the model calls it
  profiles: ToolProfile[]                   // which profiles include this tool
  modes: ("adhoc" | "ferment")[]            // which modes expose this tool; "ferment" covers interactive + oneshot
  routing?: "interactive" | "judge" | "n/a" // optional metadata for user-facing tools; informational only
}

// Shared by both modes — read/grep/find/ls/web_fetch/web_search
const SHARED_CORE_TOOLS: ToolEntry[] = [
  { name: "read", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "grep", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "find", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "ls", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "web_fetch", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "web_search", profiles: ["idle", "planning-adhoc", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
]

// Adhoc-only — --plan tools
const ADHOC_MODE_TOOLS: ToolEntry[] = [
  { name: "questionnaire", profiles: ["planning-adhoc"], modes: ["adhoc"], routing: "interactive" },
  { name: "update_todos", profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "add_todo", profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "mark_todo", profiles: ["planning-adhoc"], modes: ["adhoc"] },
  { name: "clear_todos", profiles: ["planning-adhoc"], modes: ["adhoc"] },
]

// Ferment-only — ferment lifecycle (covers interactive + oneshot)
const FERMENT_MODE_TOOLS: ToolEntry[] = [
  { name: "list_ferments", profiles: ["idle", "planning-ferment", "implementation-ferment"], modes: ["adhoc", "ferment"] },
  { name: "propose_ferment_scoping", profiles: ["planning-ferment"], modes: ["ferment"] },
  { name: "scope_ferment", profiles: ["planning-ferment", "implementation-ferment"], modes: ["ferment"] },
  { name: "update_ferment_scope_field", profiles: ["planning-ferment"], modes: ["ferment"] },
  { name: "confirm_ferment_completion_criteria", profiles: ["planning-ferment"], modes: ["ferment"], routing: "interactive" },
  { name: "ask_user", profiles: ["planning-ferment"], modes: ["ferment"], routing: "interactive" },
  { name: "set_phase", profiles: ["planning-ferment", "implementation-ferment"], modes: ["ferment"] },
  { name: "activate_ferment_phase", profiles: ["planning-ferment", "implementation-ferment"], modes: ["ferment"] },
  { name: "refine_ferment_phase", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "complete_ferment_phase", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "skip_ferment_phase", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "fail_ferment_phase", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "start_ferment_step", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "complete_ferment_step", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "verify_ferment_step", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "skip_ferment_step", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "fail_ferment_step", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "add_ferment_decision", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "add_ferment_memory", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "complete_ferment", profiles: ["implementation-ferment"], modes: ["ferment"] },
]

// Implementation-only — write tools (ferment only; --plan admits read-only bash with runtime gate, not catalog omission)
const WRITE_TOOLS: ToolEntry[] = [
  { name: "bash", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "edit", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "write", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "Agent", profiles: ["implementation-ferment"], modes: ["ferment"] },
  { name: "get_subagent_result", profiles: ["implementation-ferment"], modes: ["ferment"] },
]

export function getToolsForProfile(profile: ToolProfile, mode: "adhoc" | "ferment"): string[] {
  const all = [...SHARED_CORE_TOOLS, ...ADHOC_MODE_TOOLS, ...FERMENT_MODE_TOOLS, ...WRITE_TOOLS]
  return all.filter((t) => t.profiles.includes(profile) && t.modes.includes(mode)).map((t) => t.name)
}
```

**2. Add unit tests** at `src/shared/planning/tool-catalog.test.ts`.
- Verify: `pnpm vitest run src/shared/planning/tool-catalog.test.ts`
- Accept when: All profile derivations return expected tool sets for `idle`, `planning-adhoc`, `planning-ferment`, `implementation-ferment`, `worker`; mode-specific tools (e.g., `questionnaire` vs `ask_user`) appear only in their respective modes; `routing` metadata is preserved for `ask_user` and `confirm_ferment_completion_criteria`.

**3. Migrate `permissions/index.ts`** — replace `PLAN_MODE_TOOLS` (`index.ts:82-93`) and `PLAN_MODE_TOOL_SET` (`index.ts:96`) usage with `getToolsForProfile("planning-adhoc", "adhoc")`. Keep re-export for backwards compat.
- Verify: `grep -c 'PLAN_MODE_TOOLS' src/extensions/permissions/index.ts | awk '{exit !($1 <= 1)}' && grep -c 'getToolsForProfile' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}'`
- Accept when: `--plan` mode sees the same tool set as before (verified by snapshot test).

**4. Migrate `extensions/ferment/tool-scope.ts`** — replace `PLANNING_TOOL_NAMES` (`tool-scope.ts:18-48`) and `IMPLEMENTATION_TOOL_NAMES` (`tool-scope.ts:50-84`) with `getToolsForProfile("planning-ferment", "ferment")` and `getToolsForProfile("implementation-ferment", "ferment")`.
- Verify: `grep -c 'getToolsForProfile' src/extensions/ferment/tool-scope.ts | awk '{exit !($1 >= 2)}'`
- Accept when: Ferment planning and implementation profiles see the same tool sets as before — for both interactive and oneshot ferment.

**5. Add integration tests** extending `permissions/index.test.ts` and `extensions/ferment/tool-scope.test.ts` to assert migrated consumers return identical sets to pre-migration versions (snapshot comparison).
- Verify: `pnpm vitest run src/extensions/permissions/index.test.ts src/extensions/ferment/tool-scope.test.ts`
- Accept when: No regressions in tool-set membership for either mode.

**6. Run full validation.**
- Verify: `pnpm run lint && pnpm run typecheck && pnpm vitest run`
- Accept when: All checks exit 0.

### Phase verify command
```bash
pnpm run lint && pnpm run typecheck && pnpm vitest run && \
  test -f src/shared/planning/tool-catalog.ts && \
  test -f docs/tool-name-mapping.md && \
  grep -q 'SHARED_CORE_TOOLS' src/shared/planning/tool-catalog.ts && \
  grep -q 'ADHOC_MODE_TOOLS' src/shared/planning/tool-catalog.ts && \
  grep -q 'FERMENT_MODE_TOOLS' src/shared/planning/tool-catalog.ts && \
  grep -q 'WRITE_TOOLS' src/shared/planning/tool-catalog.ts
```

### Gates
- **P1** (verification quality): Tool name audit step; catalog unit tests; integration snapshot tests; routing metadata preserved.
- **P2** (combined output): Three inline definitions replaced by one shared catalog with mode-flavored entries; both UXs (interactive and oneshot) work.
- **P3** (deferred items): None. The mapping doc is the authoritative reference for subsequent phases.

---

## Phase 2: Shared Tool Visibility Mechanism

### Goal
Replace `applyPlanModeTools` (`src/extensions/permissions/index.ts:279-298`) and `FermentToolScope.applyProfile` (`src/extensions/ferment/tool-scope.ts:97-130`) with a shared `ToolProfileManager.apply(profile)` at `src/shared/planning/tool-profile-manager.ts`. Pi-mono `setActiveTools()` is the canonical primitive; cooperative `ToolVisibilityAPI` (`planModeApplied`, `planModeHiddenTools` at `index.ts:203`) is no-op fallback after snapshot. The layering rule applies uniformly to interactive and oneshot ferment.

### Pre-conditions
- Phase 1 complete.
- Both UXs work as today.

### Steps

**1. Create `ToolProfileManager`** with `apply(profile, mode)` calling `pi.setActiveTools(getToolsForProfile(...))`. Tracks `snapshot-applied-this-turn` flag.
- Verify: `test -f src/shared/planning/tool-profile-manager.ts && grep -c 'setActiveTools' src/shared/planning/tool-profile-manager.ts`
- Accept when: Module exports `apply` and tracks per-turn snapshot state.

**2. Add layering rule** — when `apply` is called this turn, subsequent `pi.tweakTools()` calls are no-ops. Flag resets at turn boundary.
- Verify: `grep -c 'snapshot-applied-this-turn\|tweakTools' src/shared/planning/tool-profile-manager.ts`
- Accept when: Layering rule implemented and documented.

**3. Add unit tests** at `src/shared/planning/tool-profile-manager.test.ts` covering: (a) snapshot called on apply, (b) cooperative no-op after snapshot, (c) cooperative applies when no snapshot, (d) flag resets at turn boundary.
- Verify: `pnpm vitest run src/shared/planning/tool-profile-manager.test.ts`
- Accept when: All layering cases pass.

**4. Migrate `permissions/index.ts`** — replace `applyPlanModeTools` (`index.ts:279-298`) with `ToolProfileManager.apply(profile, "adhoc")`.
- Verify: `grep -c 'ToolProfileManager.apply' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}'`
- Accept when: `--plan` mode switches tool sets via shared manager.

**5. Migrate `extensions/ferment/tool-scope.ts`** — replace `FermentToolScope.applyProfile` (`tool-scope.ts:97-130`) with `ToolProfileManager.apply(profile, "ferment")`. Works for both interactive and oneshot ferment since they share the same catalog flavor.
- Verify: `grep -c 'ToolProfileManager.apply' src/extensions/ferment/tool-scope.ts | awk '{exit !($1 >= 1)}'`
- Accept when: Ferment profile switches via shared manager (interactive and oneshot).

**6. Add integration tests** for transitions: default → plan, plan → auto, default → ferment, ferment implementation → completion, oneshot (start in ferment planning → activate → implementation).
- Verify: `pnpm vitest run src/extensions/permissions/index.test.ts src/extensions/ferment/tool-scope.test.ts src/extensions/ferment/oneshot.test.ts`
- Accept when: All transitions work via shared manager; old function names resolve via re-exports.

**7. Add TUI e2e test** at `tests/e2e/tui/plan-mode-tool-switch.test.ts` — `--plan` flag → see read tools → execute → see write tools.
- Verify: `pnpm test:e2e:tui tests/e2e/tui/plan-mode-tool-switch.test.ts`
- Accept when: TUI shows expected tools at each state.

**8. Run full validation.**
- Verify: `pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui`
- Accept when: All checks exit 0.

### Phase verify command
```bash
pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui && \
  test -f src/shared/planning/tool-profile-manager.ts && \
  grep -q 'snapshot-applied-this-turn' src/shared/planning/tool-profile-manager.ts
```

### Gates
- **P1** (verification quality): Unit tests for layering rule + integration tests for both UXs (interactive and oneshot) + TUI e2e.
- **P2** (combined output): Single canonical visibility primitive with cooperative no-op fallback; both UXs switch correctly.
- **P3** (deferred items): Third-party extension behavior via `pi.tweakTools()` to be validated with real extensions before final ship.

---

## Phase 3: 3-Option Plan-Complete Dropdown Integration (with tool-swap semantics; oneshot-excluded)

### Goal
Add `START_AS_FERMENT` to the plan-complete dropdown at `src/extensions/permissions/index.ts:498`. On selection: decompose plan → create ferment → transition to `implementation-ferment` profile at next turn boundary. Tool names swap from `--plan` (`questionnaire`) to ferment (`ask_user`) at the turn boundary. **Oneshot ferment sessions bypass the dropdown entirely.**

### Pre-conditions
- Phases 1 and 2 complete.
- Tool name mapping doc at `docs/tool-name-mapping.md` is the authoritative reference.
- Ferment lifecycle tools work as today.

### Steps

**1. Create plan decomposition module** at `src/shared/planning/plan-decomposition.ts` — `decomposePlanToPhase(planText: string): PlannedPhase`. Splits on `## Section` headings; falls back to single-step phase when headings absent.
- Verify: `test -f src/shared/planning/plan-decomposition.ts`
- Accept when: Module exports the decomposition function with documented I/O.

**2. Add unit tests** at `src/shared/planning/plan-decomposition.test.ts` — multi-heading, no-heading, nested-heading, empty-plan cases.
- Verify: `pnpm vitest run src/shared/planning/plan-decomposition.test.ts`
- Accept when: All cases pass.

**3. Wire `START_AS_FERMENT` (interactive sessions only).** Extend the dropdown from `[EXECUTE, DECLINE]` to `[EXECUTE, DECLINE, START_AS_FERMENT]`. Add a `ferment-oneshot` flag guard at the top of the dropdown branch — if set, skip the dropdown entirely (oneshot sessions proceed directly through the ferment lifecycle, no human in the loop). Branch in `turn_end` handler calls `decomposePlanToPhase(text)`, creates ferment via lifecycle, queues a profile transition via `ToolProfileManager.apply("implementation-ferment", "ferment")` to take effect at the next turn boundary.
- Verify: `grep -c 'START_AS_FERMENT' src/extensions/permissions/index.ts | awk '{exit !($1 >= 3)}' && grep -c 'ferment-oneshot' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}'`
- Accept when: Dropdown shows 3 options in interactive sessions; oneshot sessions bypass entirely.

**4. Tool-swap semantics — document the contract.** When the profile transitions from `planning-adhoc` to `implementation-ferment` at the next turn boundary, the model sees the tool set change:
- `questionnaire` is removed (adhoc-only).
- `ask_user` is added (ferment-only).
- `update_todos`/`add_todo`/`mark_todo`/`clear_todos` are removed (adhoc-only).
- `set_phase` and the ferment lifecycle tools are added (ferment-only).
- Shared core tools remain: `read`, `grep`, `find`, `ls`, `web_fetch`, `web_search`.

This is a snapshot swap at the turn boundary — the model sees `questionnaire` for the turn in which START_AS_FERMENT is chosen, then `ask_user` from the next turn forward. No explicit handoff message is injected (consistent with snapshot semantics).
- Verify: `grep -c 'snapshot\|next turn\|turn boundary' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}'`
- Accept when: Tool-swap contract is documented in code comments at the START_AS_FERMENT branch.

**5. Add `FermentPlanStore` integration** — START_AS_FERMENT writes decomposed phase to `.kimchi/ferments/<id>.json` via `FermentPlanStore.save()`.
- Verify: `grep -c 'FermentPlanStore' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}'`
- Accept when: Ferment artifact created with decomposed phase.

**6. Add integration tests** — dropdown shows 3 options in interactive mode; oneshot bypasses dropdown entirely; START_AS_FERMENT creates ferment; profile transitions correctly; tool names swap at turn boundary per the mapping doc.
- Verify: `pnpm vitest run src/extensions/permissions/index.test.ts src/extensions/ferment/oneshot.test.ts`
- Accept when: All 3 dropdown paths work in tests; oneshot exclusion verified; tool-swap semantics verified.

**7. Add TUI e2e tests.**
- Positive: `tests/e2e/tui/plan-to-ferment-promo.test.ts` — `--plan` mode → produce plan → pick Start as Ferment → verify ferment artifact exists and session shows `ask_user` (not `questionnaire`) from the next turn forward.
- Negative: `tests/e2e/tui/oneshot-bypasses-dropdown.test.ts` — `--ferment-oneshot` session → no dropdown appears → lifecycle proceeds directly.
- Verify: `pnpm test:e2e:tui tests/e2e/tui/plan-to-ferment-promo.test.ts tests/e2e/tui/oneshot-bypasses-dropdown.test.ts`
- Accept when: Both tests pass; TUI shows expected tools at each state.

**8. Run full validation.**
- Verify: `pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui`
- Accept when: All checks exit 0.

### Phase verify command
```bash
pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui && \
  test -f src/shared/planning/plan-decomposition.ts && \
  grep -c 'START_AS_FERMENT' src/extensions/permissions/index.ts | awk '{exit !($1 >= 3)}' && \
  grep -c 'ferment-oneshot' src/extensions/permissions/index.ts | awk '{exit !($1 >= 1)}' && \
  test -f tests/e2e/tui/plan-to-ferment-promo.test.ts && \
  test -f tests/e2e/tui/oneshot-bypasses-dropdown.test.ts
```

### Gates
- **P1** (verification quality): Unit tests for decomposition + integration tests for dropdown (positive + oneshot exclusion) + TUI e2e covering both interactive and oneshot paths.
- **P2** (combined output): 3-option dropdown works for interactive sessions; oneshot bypasses; START_AS_FERMENT creates ferment and transitions profile at next turn boundary; tool names swap per the mapping doc.
- **P3** (deferred items): LLM-assisted extraction noted as future enhancement for richer plan structures.

---

## Phase 4: Secondary Components

### Goal
Consolidate `PromptSupplementRegistry`, `EntryTriggerRegistry`, `PlanArtifactStore` — each becomes a shared module under `src/shared/planning/`. Both modes (interactive and oneshot) consume the same registries.

### Pre-conditions
- Phases 1–3 complete.

### Steps

**1. Create `PromptSupplementRegistry`** with `register(key, block)` and `compose(mode)`.
- Verify: `test -f src/shared/planning/prompt-supplement-registry.ts`

**2. Migrate permissions supplement** — replace `blocks.register({ id: "plan-mode-supplement", ... })` at `index.ts:470-477` with `PromptSupplementRegistry.register("plan-mode-supplement", block)`.

**3. Migrate ferment prompt block** — register via shared registry. Works for both interactive and oneshot ferment (same registry, same block).

**4. Create `EntryTriggerRegistry`** with `register(trigger)` and `dispatch(event)`. Owns routing table (trigger → mode's FSM).

**5. Migrate entry triggers** — register `--plan` CLI flag, `shift+tab` cycling, `questionnaire` auto-promotion (`index.ts:595`), `/ferment new`, and `KIMCHI_ACTIVE_FERMENT=<id>` (`state.ts:22-25`). Each mode reads triggers from the registry.

**6. Create `PlanArtifactStore`** with interface + `AdhocPlanStore` (writes `.kimchi/plans/<timestamp>.md`) + `FermentPlanStore` (writes `.kimchi/ferments/<id>.json`).

**7. Migrate save/load** — `saveApprovedPlan` (`index.ts:504`) → `AdhocPlanStore.save()`; ferment artifact → `FermentPlanStore.save()` / `load()`.

**8. Add unit + integration tests** for each new module.
- Verify: `pnpm vitest run src/shared/planning/`

**9. Run full validation.**
- Verify: `pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui`

### Phase verify command
```bash
pnpm run lint && pnpm run typecheck && pnpm vitest run && pnpm test:e2e:tui && \
  for f in prompt-supplement-registry entry-trigger-registry plan-artifact-store; do \
    test -f "src/shared/planning/$f.ts" || exit 1; \
  done && \
  grep -c 'PromptSupplementRegistry\|EntryTriggerRegistry\|PlanArtifactStore' \
    src/extensions/permissions/index.ts src/extensions/ferment/ \
    | awk -F: '{s+=$1} END{exit !(s >= 5)}'
```

### Gates
- **P1** (verification quality): Unit tests for each registry/store + integration tests for both modes (interactive and oneshot).
- **P2** (combined output): All three secondary components consolidated; both modes consume shared interfaces.
- **P3** (deferred items): ACP multi-session event-bus redesign out of scope; interfaces must be session-agnostic to accommodate future work.

---

## Out of Scope

- UX changes to either `--plan` or ferment (interactive or oneshot).
- Deprecating either mode.
- Renaming `questionnaire` → `ask_user` (kept as separate tool names per mode per the mapping doc; intentional design choice).
- Oneshot-specific catalog entries (oneshot uses the same `ferment` flavor as interactive ferment; runtime routing differentiates via `src/extensions/ferment/ask-user.ts`).
- Oneshot-specific dropdown integration (oneshot bypasses the plan-complete dropdown entirely via the `ferment-oneshot` flag guard).
- Refactoring `src/extensions/ferment/ask-user.ts` to use a unified routing abstraction across all interactive tools (separate concern; may be a follow-on ferment).
- Changing the judge model or its routing logic (`src/extensions/ferment/judge.ts`).
- Explicit handoff message at the START_AS_FERMENT transition (snapshot swap semantics — model sees old tool for one turn, then new tools from next turn forward; no message needed).
- LLM-assisted plan extraction (noted as future enhancement in Phase 3).
- ACP event-bus redesign (noted as future work in Phase 4).

---

## Cross-Phase Reference

| File | Created/touched in | Purpose |
|------|--------------------|---------|
| `docs/tool-name-mapping.md` | Phase 1, Step 0 | Authoritative tool name + routing reference for both modes |
| `src/shared/planning/tool-catalog.ts` | Phase 1, Step 1 | Shared catalog: SHARED_CORE_TOOLS + ADHOC_MODE_TOOLS + FERMENT_MODE_TOOLS + WRITE_TOOLS + `getToolsForProfile` |
| `src/shared/planning/tool-catalog.test.ts` | Phase 1, Step 2 | Catalog unit tests |
| `src/shared/planning/tool-profile-manager.ts` | Phase 2, Step 1 | Shared visibility mechanism (snapshot + cooperative no-op) |
| `src/shared/planning/tool-profile-manager.test.ts` | Phase 2, Step 3 | Layering rule tests |
| `src/shared/planning/plan-decomposition.ts` | Phase 3, Step 1 | Plan text → PlannedPhase decomposition |
| `src/shared/planning/plan-decomposition.test.ts` | Phase 3, Step 2 | Decomposition unit tests |
| `src/shared/planning/prompt-supplement-registry.ts` | Phase 4, Step 1 | Prompt supplement registry |
| `src/shared/planning/entry-trigger-registry.ts` | Phase 4, Step 4 | Entry trigger registry |
| `src/shared/planning/plan-artifact-store.ts` | Phase 4, Step 6 | PlanArtifactStore interface + Adhoc/Ferment implementations |
| `tests/e2e/tui/plan-mode-tool-switch.test.ts` | Phase 2, Step 7 | TUI e2e: plan mode tool transitions |
| `tests/e2e/tui/plan-to-ferment-promo.test.ts` | Phase 3, Step 7 | TUI e2e: plan → ferment promotion |
| `tests/e2e/tui/oneshot-bypasses-dropdown.test.ts` | Phase 3, Step 7 | TUI e2e: oneshot bypasses dropdown |
