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
  charter          → ## Intent charter (intent verbatim + wow_factor + demo_script)
  self_critique    → ## Self-critique (meh-test)
  scope_deltas     → ## Scope decisions vs the literal request
  constraint_costs → ## Constraint costs
  quality_dimensions → ## Quality dimensions
  questions        → any remaining decision-blocking Open Questions (empty when none remain)
  gates            → P1/P2/P3 verdicts (required; see gate guidance in the planner supplement)
Default to one phase for simple tasks; add phases only for real vertical slices, different
complexity tiers, independent workstreams, or distinct code localities.

Size steps realistically: aim for 3–6 steps per phase, each ~10+ minutes of independent
work. One mega-step flanked by trivial stamps leads to mock work; rebalance the split if
one step dwarfs the rest (>3x the effort of the next-largest). When a later step turns out
already covered by earlier work, complete it with subsumed=true + absorbed_by instead of
redoing or mock-completing it.

Verification contract for every step "verify" command you write:
  • Runtime-claim steps (you claim behavior works) need BEHAVIORAL verification — a
    command that executes the artifact and asserts its behavior (run tests, boot the
    server and curl it, run the CLI and grep its output).
  • Existence/grep checks ("test -f …", "grep -q …") are acceptable ONLY for scaffolding
    steps whose output is a file or config consumed by later steps.
  • Banned: echo-only "manual inspection" verifies ("echo 'Manual check…'") — they prove
    nothing and fool nobody.
  • complete_ferment_phase re-runs every declared verify command deterministically before
    grading, and the grader sees exactly what ran (with output tails). Proxy verifies on
    runtime-claim steps lower the phase grade — put the real check in the plan.

Step shape contract: describe every step as one cohesive, verifiable change (a
  component + its test, an API slice, a config + its verify) that stands on its own
  regardless of who executes it. Avoid app-wide assembly steps that stitch many files
  in one wave; order scaffolding first so later steps integrate against a stable
  surface.
</scoping_sequence>`
