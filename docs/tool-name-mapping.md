# Tool Name Mapping

> **Status:** Authoritative reference for Phase 1 (Shared Tool Catalog) of the planning modes unification effort. Produced from `docs/planning-modes-unification-rfc.md` (design authority) and `docs/planning-modes-implementation-plan.md` (implementation sequence). The table below is consulted by every subsequent phase.

## Overview

The `--plan` and ferment modes maintain separate tool catalogs even when the underlying operation is similar. This doc is the authoritative reference for (a) which tool name applies in which mode, (b) how the catalogs are structured, and (c) how interactive vs oneshot routing works for user-facing tools. The shared core (`read`, `grep`, `find`, `ls`, `web_fetch`, `web_search`) is available in both modes; mode-specific tools differ in name or availability. Oneshot ferment follows the same catalog as interactive ferment; runtime routing differentiates via `src/extensions/ferment/ask-user.ts`.

## Cross-Phase Mapping

| Concept | `--plan` name | Ferment name | Oneshot behavior | Notes |
|---------|---------------|--------------|------------------|-------|
| Ask user structured question | `questionnaire` | `ask_user` | `ask_user` (judge-routed) | Both render the same form UI; differ only in tool name and header content. Oneshot routes to judge model via `askUser()` in `ask-user.ts`. |
| Confirm scope completion | (none) | `confirm_ferment_completion_criteria` | Same tool, judge-routed | Ferment-specific gating tool. Oneshot routes to judge model. Both `ask_user` and `confirm_ferment_completion_criteria` are listed in `USER_FACING_FERMENT_TOOL_NAMES` (`tool-names.ts`) and skip the internal-tool bypass in the permissions handler. |
| Task/phase tracker | `update_todos`, `add_todo`, `mark_todo`, `clear_todos` | `set_phase` | `set_phase` | Different conceptual operation; both modes expose a tracker. `--plan` uses todo-list tools; ferment uses a phase-label setter. |
| Read-only discovery | `read`, `grep`, `find`, `ls`, `web_fetch`, `web_search` | `read`, `grep`, `find`, `ls`, `web_fetch`, `web_search` | Same | Identical tool names; part of shared core in the catalog. |
| Read-only shell access | `bash` (gated to read-only) | (hidden in planning profile) | (hidden in planning profile) | `--plan` admits read-only bash with a runtime gate at `index.ts:549-558`. Ferment planning profile omits `bash` entirely from `PLANNING_TOOL_NAMES` (`tool-scope.ts:18-48`). |
| Ferment discovery | (none) | `list_ferments` | Same | Ferment-specific; visible in idle and planning profiles. Listed in `NON_PLANNER_FERMENT_TOOL_NAMES` (`tool-names.ts`). |
| Scope creation | (none) | `propose_ferment_scoping`, `scope_ferment`, `update_ferment_scope_field` | Same | Ferment-specific scoping surface. `propose_ferment_scoping` is the planning-entry tool; `scope_ferment` and `update_ferment_scope_field` handle draft edits. |
| Lifecycle phase transitions | (none — mode-switch only) | `activate_ferment_phase`, `refine_ferment_phase`, `complete_ferment_phase`, `skip_ferment_phase`, `fail_ferment_phase` | Same | Ferment-specific FSM transitions. `activate_ferment_phase` is included in planning profile as the trigger for the planning-to-implementation swap. |
| Lifecycle step management | (none) | `start_ferment_step`, `complete_ferment_step`, `verify_ferment_step`, `skip_ferment_step`, `fail_ferment_step` | Same | Ferment-specific step FSM. Available in implementation profile (`IMPLEMENTATION_TOOL_NAMES` in `tool-scope.ts`). |
| Knowledge capture | (none) | `add_ferment_decision`, `add_ferment_memory` | Same | Ferment-specific; captures architectural decisions and reusable patterns. Implementation profile only. |
| Phase/ferment completion | (none) | `complete_ferment` | Same | Terminal ferment lifecycle tool. Triggers FSM transition to `complete`. Implementation profile only. |
| Execution tools | (none) | `bash`, `edit`, `write`, `Agent`, `get_subagent_result` | Same (implementation only) | Ferment implementation profile only. `bash` is unrestricted here (vs read-only in `--plan`). `Agent` and `get_subagent_result` are the delegation surface. |

## Routing Semantics

Two tools are user-facing in ferment — they present choices to a human and must not be silently auto-approved by the permissions bypass:

- `ask_user` — structured question tool (analogous to `--plan`'s `questionnaire`)
- `confirm_ferment_completion_criteria` — scope gating tool

Both are listed in `USER_FACING_FERMENT_TOOL_NAMES` (`tool-names.ts`) which opts them back into normal permission evaluation (skips the internal-tool bypass). Their routing behavior differs by session type:

| Tool | Interactive ferment (TUI attached) | Oneshot ferment (`--ferment-oneshot`) |
|------|-------------------------------------|--------------------------------------|
| `ask_user` | Routes to TUI via `promptForm()` in `prompt-ui.ts`. User picks from options or types free text. | Routes to judge model via `askJudge()` in `ask-user.ts`. Judge sees goal, success criteria, current phase/step, question, and options; returns one choice with a rationale. |
| `confirm_ferment_completion_criteria` | Routes to TUI for human confirmation of scope completeness. | Routes to judge model (same `askJudge()` path via the tool handler). |

The routing decision is made in `ask-user.ts` by `isOneShotSession()` which reads `pi.getFlag("ferment-oneshot")`. In one-shot mode, the judge is the only legitimate audience — even if a TUI happens to be attached to the process, the contract says unattended runs must not prompt for human input.

> **Note:** The "Ferment name" column in the table above covers both interactive and oneshot ferment — runtime routing differentiates, not the catalog. The `ferment` mode-flavor is shared.

## Source of Truth

This doc is the authoritative reference for tool names per mode. It was produced by grepping `src/extensions/permissions/` and `src/extensions/ferment/` for tool-name string literals:

- `PLAN_MODE_TOOLS` at `src/extensions/permissions/index.ts:82-93`
- `PLANNING_TOOL_NAMES` and `IMPLEMENTATION_TOOL_NAMES` at `src/extensions/ferment/tool-scope.ts:18-84`
- `FERMENT_TOOLS` enum at `src/extensions/ferment/tool-names.ts`
- Inline tool names in tool registration code

Subsequent phases MUST consult this table before adding tool entries to the shared catalog or modifying routing behavior.