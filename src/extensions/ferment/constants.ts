import { SHARED_PLANNING_PROCESS } from "../../shared/planning/shared-planning-process.js"

export const SCOPING_EXPLORE_TOKEN_BUDGET = 120_000

export const SCOPING_DISCOVERY_GUIDANCE = `<scoping_sequence required="true">
The host monitors your progress and will intervene if you spend too many turns exploring
without advancing. Your goal is to reach propose_ferment_scoping, not to understand
every file in the project.

${SHARED_PLANNING_PROCESS}

## Ferment Tool Bindings

STEP 2 — use ask_user (set allowOther: true on all option lists).

STEP 3 — use confirm_ferment_completion_criteria (not ask_user). The tool returns
Confirmed: yes/no and a free-form Changes field. Revise and re-call until Confirmed: yes
and Changes is empty.

STEP 4 — spawn Explore subagents instead of reading files yourself:
  • subagent_type: "Explore" (or closest available)
  • token_budget: ${SCOPING_EXPLORE_TOKEN_BUDGET}
  • run_in_background: true when multiple independent unknowns exist
  • Prefer several narrow probes over one broad "understand everything" scan

STEP 5 — call propose_ferment_scoping with the plan payload. The tool fields map to the
plan structure defined above:
  goal             → ## Goal
  constraints      → ## Constraints
  phases           → ## Chunks (each phase = one chunk; steps = sub-tasks within it)
  success_criteria → ## Verification Strategy
  assumptions      → ## Decision Log
  questions        → any remaining decision-blocking Open Questions (empty when none remain)
  gates            → P1/P2/P3 verdicts (required; see gate guidance in the planner supplement)
Default to one phase for simple tasks; add phases only for real vertical slices, different
complexity tiers, independent workstreams, or distinct code localities.
</scoping_sequence>`
