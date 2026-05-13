import { evaluatePhaseFeedback, renderSelfImprovementSection } from "../../ferment/self-improve.js"
import type { Ferment } from "../../ferment/types.js"
import { formatDecisionsAndMemories, formatScopingContext } from "./format.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

export async function buildPlannerSupplement(runtime: FermentRuntime = defaultFermentRuntime): Promise<string> {
	const f = runtime.getActive()
	if (!f) return ""
	const dm = formatDecisionsAndMemories(f)
	const dmSection = dm ? `\n\n${dm}` : ""
	const sc = formatScopingContext(f)
	const scSection = sc ? `\n\n${sc}` : ""

	// Self-improvement feedback: inject previous phase's grade if available
	const selfImprovementSection = buildSelfImprovementSection(runtime, f)

	return `\n\n## Ferment Planner Role

You are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers.

**State machine:**
- The ferment engine's determineNextAction() determines the next action from state
- Read it via the engine, then execute that action directly
- For start_step: call the tool, read worker_model from the result, spawn a subagent with provider "kimchi-dev"
- If start_step returns parallel_siblings, call start_step for all of them and spawn their subagents CONCURRENTLY
- After a subagent returns, call complete_step with its summary
- For phase transitions (activate_phase, complete_phase, complete_ferment): call the tool directly, no subagent needed
- Worker models: minimax-m2.7 for code/text, kimi-k2.5 for vision tasks

**Rules:**
- NEVER write, edit, or read files yourself during step execution
- NEVER implement a step inline — always delegate to a subagent worker
- If the current action is complete_step: this is a SUGGESTION — the LLM decides when the step is done based on subagent results

**Parallel phases:**
- When activate_phase returns parallel_group, all listed phase_ids are active simultaneously
- Call refine_phase for ALL parallel phases in the same turn, then execute their steps concurrently
- Complete each parallel phase independently with complete_phase when its steps finish
- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped

**Parallel steps (inside one phase):**
- When start_step returns parallel_siblings, call start_step for every sibling in the SAME turn and spawn all their subagents concurrently — do NOT wait for one to finish before starting the next
- Wait for all sibling subagents to return, then call complete_step for each one
- Two parallel steps must share the same group; the FSM rejects cross-group concurrent starts

**Knowledge capture:**
- Call add_decision after any architectural or design choice that affects future phases
- Call add_memory for reusable patterns, gotchas, or conventions discovered during execution
${selfImprovementSection}${scSection}${dmSection}`
}

/**
 * Build self-improvement feedback section for the planner based on previous phase grade.
 *
 * Pulls the corrective step (if any) from the in-memory cache populated by
 * complete_phase. The cache may be empty either because the previous grade was
 * not D/F or because the judge call hasn't completed yet — both fine, the
 * suggestion is best-effort.
 */
function buildSelfImprovementSection(runtime: FermentRuntime, ferment: Ferment): string {
	const completedPhases = ferment.phases.filter((p) => p.status === "completed" && p.grade)
	if (completedPhases.length === 0) return ""

	const lastGradedPhase = completedPhases[completedPhases.length - 1]
	if (!lastGradedPhase.grade) return ""

	const grade = lastGradedPhase.grade
	const feedback = evaluatePhaseFeedback(grade)
	const correctiveStep = runtime.getCorrectiveStep(ferment.id, lastGradedPhase.id)
	return renderSelfImprovementSection(grade, feedback, correctiveStep)
}
