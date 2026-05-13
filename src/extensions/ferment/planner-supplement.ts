import { evaluatePhaseFeedback, renderSelfImprovementSection } from "../../ferment/self-improve.js"
import type { Ferment } from "../../ferment/types.js"
import { getAgentConfig, getDefaultAgentNames } from "../agents/personas/agent-types.js"
import { formatDecisionsAndMemories, formatScopingContext } from "./format.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

/** Pull the first line of an agent's description (typically a one-sentence role
 *  summary) so the planner can pick the right subagent without each entry
 *  bloating the supplement. Caps the line at 140 chars as a safety net. */
function buildAgentsSection(): string {
	const types = getDefaultAgentNames()
	if (types.length === 0) return ""
	const lines = types.map((t) => {
		const cfg = getAgentConfig(t)
		const firstLine = (cfg?.description ?? "").split("\n")[0].trim()
		const desc = firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
		return `- **${t}**${desc ? ` — ${desc}` : ""}`
	})
	return `\n\n**Available subagent types (pick one per start_step by step intent):**\n${lines.join("\n")}`
}

export function buildPlannerSupplement(runtime: FermentRuntime = defaultFermentRuntime): string {
	const f = runtime.getActive()
	if (!f) return ""
	const dm = formatDecisionsAndMemories(f)
	const dmSection = dm ? `\n\n${dm}` : ""
	const sc = formatScopingContext(f)
	const scSection = sc ? `\n\n${sc}` : ""

	// Self-improvement feedback: inject previous phase's grade if available
	const selfImprovementSection = buildSelfImprovementSection(runtime, f)
	const agentsSection = buildAgentsSection()

	return `\n\n## Ferment Planner Role\n\nYou are the PLANNER for ferment "${f.name}". Your job is to manage the task graph and delegate all implementation work to subagent workers.\n\n**State machine:**\n- The ferment engine's determineNextAction() determines the next action from state\n- Read it via the engine, then execute that action directly\n- For start_step: call the tool, read worker_model from the result, spawn a subagent with provider "kimchi-dev"\n- If start_step returns parallel_siblings, call start_step for all of them and spawn their subagents CONCURRENTLY\n- After a subagent returns, call complete_step with its summary\n- For phase transitions (activate_phase, complete_phase, complete_ferment): call the tool directly, no subagent needed\n- Worker models: minimax-m2.7 for code/text, kimi-k2.5 for vision tasks\n\n**Rules:**\n- NEVER write, edit, or read files yourself during step execution\n- NEVER implement a step inline — always delegate to a subagent worker\n- Spawn a subagent for every step regardless of whether you already know the answer — the subagent exists to produce verifiable evidence, not just to do work. No-op or trivially-known steps still require a subagent run.\n- If the current action is complete_step: this is a SUGGESTION — the LLM decides when the step is done based on subagent results\n- If the specification names a fixed output path or fixed runtime interface, the worker directive must keep it fixed; do not turn it into an extra CLI argument, config option, or flexible interface unless the user explicitly requested that${agentsSection}\n\n**Parallel phases:**\n- When activate_phase returns parallel_group, all listed phase_ids are active simultaneously\n- Call refine_phase for ALL parallel phases in the same turn, then execute their steps concurrently\n- Complete each parallel phase independently with complete_phase when its steps finish\n- Only proceed to the next sequential phase once ALL phases in the parallel group are completed/skipped\n\n**Parallel steps (inside one phase):**\n- When start_step returns parallel_siblings, call start_step for every sibling in the SAME turn and spawn all their subagents concurrently — do NOT wait for one to finish before starting the next\n- Wait for all sibling subagents to return, then call complete_step for each one\n- Two parallel steps must share the same group; the FSM rejects cross-group concurrent starts\n\n**Knowledge capture:**\n- Call add_decision after any architectural or design choice that affects future phases\n- Call add_memory for reusable patterns, gotchas, or conventions discovered during execution${scSection}${dmSection}${selfImprovementSection}\n`
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
