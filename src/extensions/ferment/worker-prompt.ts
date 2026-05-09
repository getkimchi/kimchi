/**
 * Worker prompt builder.
 *
 * `start_step` returns a structured WORKER CONTEXT block the planner can paste
 * into the subagent's prompt verbatim. Without this, every spawn re-asks the
 * planner to "describe what to implement" — and the planner does so from the
 * step description alone, missing phase goal and prior-step continuity.
 *
 * We give workers three things:
 *   1. The phase goal — so they know the bigger-picture deliverable
 *   2. Prior step summaries in the same phase — so they don't redo work
 *   3. Decisions and memories captured in the ferment — so they stay consistent
 *
 * This is bounded: only the active phase's prior steps, only the most recent
 * decisions/memories. We do not give the worker the whole ferment context
 * (phases ahead, future scope) — that risks scope creep and over-eager
 * implementation.
 */

import type { Ferment, Phase, Step } from "../../ferment/types.js"

const PRIOR_STEP_SUMMARY_MAX_CHARS = 240
const MAX_DECISIONS = 5
const MAX_MEMORIES = 5

export interface WorkerContextOpts {
	includeDecisions?: boolean
	includeMemories?: boolean
}

/**
 * Build a markdown worker-context block for a step the planner is about to
 * delegate. The block is short — just enough for the worker to do the right
 * thing without re-deriving context from scratch.
 */
export function buildWorkerContext(ferment: Ferment, phase: Phase, step: Step, opts: WorkerContextOpts = {}): string {
	const lines: string[] = []
	lines.push("## Worker Context")
	lines.push(`**Ferment:** ${ferment.name}`)
	lines.push(`**Phase ${phase.index}:** ${phase.name} — ${phase.goal}`)
	lines.push(`**Step ${step.index}:** ${step.description}`)
	if (step.verification?.command) {
		lines.push(`**Verify when done:** \`${step.verification.command}\``)
	}

	const priorSteps = phase.steps
		.filter((s) => s.index < step.index)
		.filter((s) => s.status === "done" || s.status === "verified" || s.status === "skipped")

	if (priorSteps.length > 0) {
		lines.push("")
		lines.push(`**Prior steps in this phase (${priorSteps.length}):**`)
		for (const s of priorSteps) {
			const tag = s.status === "skipped" ? "⊘ skipped" : "✓"
			const summary = (s.summary ?? "").trim()
			const trimmed =
				summary.length > PRIOR_STEP_SUMMARY_MAX_CHARS ? `${summary.slice(0, PRIOR_STEP_SUMMARY_MAX_CHARS)}…` : summary
			const summaryLine = trimmed ? ` — ${trimmed}` : ""
			lines.push(`- ${tag} Step ${s.index} "${s.description}"${summaryLine}`)
		}
	}

	const includeDecisions = opts.includeDecisions ?? true
	if (includeDecisions && ferment.decisions.length > 0) {
		const recent = ferment.decisions.slice(-MAX_DECISIONS)
		lines.push("")
		lines.push("**Decisions to honor:**")
		for (const d of recent) {
			lines.push(`- ${d.title}: ${d.description}`)
		}
	}

	const includeMemories = opts.includeMemories ?? true
	if (includeMemories && ferment.memories.length > 0) {
		const recent = ferment.memories.slice(-MAX_MEMORIES)
		lines.push("")
		lines.push("**Memories to apply:**")
		for (const m of recent) {
			lines.push(`- [${m.category}] ${m.content}`)
		}
	}

	if (ferment.scoping.constraints?.answer) {
		lines.push("")
		lines.push(`**Constraints:** ${ferment.scoping.constraints.answer}`)
	}

	return lines.join("\n")
}
