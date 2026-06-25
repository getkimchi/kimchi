/**
 * Worker prompt builder.
 *
 * `start_step` returns a compact worker-context block the planner can paste
 * into the subagent's prompt verbatim. Without this, every spawn re-asks the
 * planner to "describe what to implement" — and the planner does so from the
 * step description alone, missing phase goal and prior-step continuity.
 *
 * The block is intentionally dense (one fact per line, no markdown headers).
 * Workers don't need a markdown document; they need the facts.
 */

import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { getTodosForScope } from "../todos/store.js"

const PRIOR_STEP_SUMMARY_MAX_CHARS = 240
const MAX_DECISIONS = 5
const MAX_MEMORIES = 5

export interface WorkerContextOpts {
	includeDecisions?: boolean
	includeMemories?: boolean
}

export function buildWorkerContext(ferment: Ferment, phase: Phase, step: Step, opts: WorkerContextOpts = {}): string {
	const lines: string[] = []
	lines.push("## Worker Context")
	lines.push(`Ferment: ${ferment.name}`)
	lines.push(`Phase ${phase.index}: ${phase.name} — ${phase.goal}`)
	lines.push(`Step ${step.index}: ${step.description}`)
	if (step.verification?.command) {
		lines.push(`verify: ${step.verification.command}`)
	}
	lines.push("")
	lines.push(`Ferment docs directory: .kimchi/ferments/${ferment.id}/docs/`)
	lines.push(
		"Use this directory only when the worker's role explicitly requires a durable artifact, such as implementation notes or verification reports. Explore/read-only workers must return decision-ready findings directly to the orchestrator and write no reports, docs, notes, or scratch files. Do NOT create ad-hoc project-root scratch folders like .ui-audit/ unless the user explicitly requested a product artifact in the app itself.",
	)
	if (ferment.scoping.goal?.answer) {
		lines.push("")
		lines.push(`Goal: ${ferment.scoping.goal.answer}`)
	}
	if (ferment.scoping.criteria?.answer) {
		lines.push(`Criteria: ${ferment.scoping.criteria.answer}`)
	}

	const priorSteps = phase.steps
		.filter((s) => s.index < step.index)
		.filter((s) => s.status === "done" || s.status === "verified" || s.status === "skipped")
	if (priorSteps.length > 0) {
		const priorBits = priorSteps.map((s) => {
			const tag = s.status === "skipped" ? `⊘${s.index}` : `✓${s.index}`
			const summary = (s.summary ?? "").trim()
			const trimmed =
				summary.length > PRIOR_STEP_SUMMARY_MAX_CHARS ? `${summary.slice(0, PRIOR_STEP_SUMMARY_MAX_CHARS)}…` : summary
			return trimmed ? `${tag} "${s.description}" — ${trimmed}` : `${tag} "${s.description}"`
		})
		lines.push(`Prior: ${priorBits.join("; ")}`)
	}

	const includeDecisions = opts.includeDecisions ?? true
	if (includeDecisions && ferment.decisions.length > 0) {
		const recent = ferment.decisions.slice(-MAX_DECISIONS)
		lines.push(`Decisions: ${recent.map((d) => `${d.title}: ${d.description}`).join("; ")}`)
	}

	const includeMemories = opts.includeMemories ?? true
	if (includeMemories && ferment.memories.length > 0) {
		const recent = ferment.memories.slice(-MAX_MEMORIES)
		lines.push(`Memories: ${recent.map((m) => `[${m.category}] ${m.content}`).join("; ")}`)
	}

	// Include the orchestrator's step-level implementation plan so the worker
	// knows what sub-tasks were planned and can track progress against them.
	const stepTodos = getTodosForScope({ kind: "ferment-step", phaseId: phase.id, stepId: step.id })
	if (stepTodos.length > 0) {
		const planItems = stepTodos.map((t) => {
			const glyph = t.status === "completed" ? "\u2713" : t.status === "in_progress" ? "\u25b6" : "\u25cb"
			return `${glyph} ${t.content}`
		})
		lines.push(`Plan: ${planItems.join("; ")}`)
	}

	return lines.join("\n")
}
