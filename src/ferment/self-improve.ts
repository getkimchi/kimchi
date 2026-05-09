/**
 * Self-improvement loop — pure logic.
 *
 * After each phase the judge produces a `JudgeGrade` (grade A–F + deltas).
 * `evaluatePhaseFeedback` turns that grade into structured guidance the
 * planner injects into the system prompt for the next phase.
 *
 * Three independent triggers:
 *   - low grade        (C/D/F) → "review approach" / "rethink"
 *   - many deltas      (>2)    → "review approach" even on B
 *   - very low grade   (D/F)   → request a corrective-step suggestion
 *
 * The corrective-step suggestion is computed by the host (one extra judge
 * call). This module exposes only the trigger flag and the strategy-adjustment
 * text — it does not call the judge itself.
 */

import type { JudgeGrade } from "./types.js"

export interface PhaseFeedback {
	/** One-sentence strategy adjustment for the next phase. */
	adjustment: string
	/** Whether to surface the previous deltas prominently in the prompt. */
	deltaCountTriggered: boolean
	/** Whether the host should request a corrective-step suggestion from the judge. */
	correctiveStepNeeded: boolean
	/** Number of deltas observed (for display). */
	deltaCount: number
}

/** Threshold above which delta count alone triggers a strategy change. */
export const DELTA_COUNT_THRESHOLD = 2

/**
 * Compute structured feedback from the previous phase's grade. Pure — no I/O.
 *
 * When the grade carries `unavailable: true` (judge was unreachable / output
 * unparseable), no triggers fire and the adjustment text is neutral. This
 * prevents a fully-down judge from looking like a string of B grades that
 * silently keeps the loop quiet.
 */
export function evaluatePhaseFeedback(grade: JudgeGrade): PhaseFeedback {
	if (grade.unavailable) {
		return {
			adjustment:
				"Judge was unavailable for the previous phase — no quality signal to act on. Continue current strategy and monitor verification output.",
			deltaCountTriggered: false,
			correctiveStepNeeded: false,
			deltaCount: 0,
		}
	}

	const deltaCount = grade.deltas?.length ?? 0
	const deltaCountTriggered = deltaCount > DELTA_COUNT_THRESHOLD
	const correctiveStepNeeded = grade.grade === "D" || grade.grade === "F"

	let adjustment: string
	switch (grade.grade) {
		case "A":
			adjustment = deltaCountTriggered
				? "Strong overall — but several gaps were noted; review them before continuing."
				: "Continue current strategy."
			break
		case "B":
			adjustment = deltaCountTriggered
				? "Multiple gaps identified — review the deltas and adjust the next phase's plan accordingly."
				: "Minor adjustments may improve outcomes."
			break
		case "C":
			adjustment = "Review approach for overlooked requirements and tighten the plan for the next phase."
			break
		case "D":
			adjustment = "Significant changes to strategy are needed. Address each delta before proceeding."
			break
		case "F":
			adjustment = "Rethink the entire approach. Do not proceed without addressing the deltas."
			break
	}

	return {
		adjustment,
		deltaCountTriggered,
		correctiveStepNeeded,
		deltaCount,
	}
}

/**
 * Render the previous-phase deltas as a bulleted markdown list. Returns
 * "(none)" when there are no deltas.
 */
export function renderDeltas(grade: JudgeGrade): string {
	const deltas = grade.deltas ?? []
	if (deltas.length === 0) return "(none)"
	return deltas
		.map((d, i) => `  ${i + 1}. [${d.category}] expected: ${d.expected} | actual: ${d.actual} (${d.severity})`)
		.join("\n")
}

/**
 * Build the full self-improvement section appended to the planner's system
 * prompt for the next phase. `correctiveStep` is optional — when present it
 * comes from a dedicated judge call (see `judgeSuggestCorrectiveStep`).
 */
export function renderSelfImprovementSection(
	grade: JudgeGrade,
	feedback: PhaseFeedback,
	correctiveStep?: string,
): string {
	const lines: string[] = [
		"\n\n## Self-Improvement Feedback",
		`The previous phase received grade ${grade.grade} with ${feedback.deltaCount} delta(s).`,
		`Rationale: ${grade.rationale}`,
		"Delta details:",
		renderDeltas(grade),
		"",
		`Adjustment for the next phase: ${feedback.adjustment}`,
	]

	if (feedback.deltaCountTriggered && grade.grade !== "C" && grade.grade !== "D" && grade.grade !== "F") {
		lines.push(
			`> Delta count (${feedback.deltaCount}) exceeded threshold (${DELTA_COUNT_THRESHOLD}); treat the deltas as priority items even though the grade was ${grade.grade}.`,
		)
	}

	if (correctiveStep) {
		lines.push("", "**Suggested corrective step:**", correctiveStep)
	}

	return lines.join("\n")
}
