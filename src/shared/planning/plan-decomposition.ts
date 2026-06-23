/**
 * # Plan Decomposition
 *
 * Converts a plain-text plan (potentially containing `## ` level-2 markdown
 * headings) into a structured `PlannedPhase`.
 *
 * ## Input shape
 *
 * `planText` is raw markdown emitted by the planner model.  It may be a
 * single paragraph or consist of multiple `## ` sections:
 *
 * ```markdown
 * ## Implement feature X
 * Do the thing.
 *
 * ## Write tests
 * Verify the thing works.
 * ```
 *
 * ## Output shape
 *
 * `decomposePlanToPhase` returns a `PlannedPhase` — a lightweight pre-cursor
 * to the full `Phase` runtime type defined in `src/ferment/types.ts`.  The
 * `PlannedPhase` / `PlannedStep` shapes carry only the fields the
 * START_AS_FERMENT branch needs; the caller (permissions / lifecycle code)
 * is responsible for materialising a real `Phase` from the result.
 *
 * ## Consumer contract
 *
 * The primary consumer is the `START_AS_FERMENT` branch at
 * `permissions/index.ts:498`.  Downstream lifecycle code (e.g. the ferment
 * step FSM) consumes the `PlannedPhase` produced here and creates a real
 * `Phase` instance from it.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lightweight step produced by the planner decomposer.
 * Corresponds to a `## ` section (or the entire plan when no sections exist).
 */
export interface PlannedStep {
	id: string
	index: number
	description: string
}

/**
 * Lightweight phase produced by the planner decomposer.
 * Corresponds to an entire plan text, subdivided into `PlannedStep`s.
 */
export interface PlannedPhase {
	id: string
	index: number
	name: string
	goal: string
	steps: PlannedStep[]
}

// ---------------------------------------------------------------------------
// Decomposer
// ---------------------------------------------------------------------------

/**
 * Splits a plan text into a `PlannedPhase`.
 *
 * - If `planText` contains `## ` headings, each heading section becomes a
 *   `PlannedStep`; the heading title is discarded and only the body is kept.
 * - If no headings are found, the entire `planText` is returned as a single
 *   step.
 * - Empty input (`planText.trim() === ""`) returns a phase with one step whose
 *   description is `""`.
 *
 * IDs are deterministic: `phase.id = "phase-1"`, `step.id = "step-N"` with
 * 1-based indices.
 */
export function decomposePlanToPhase(planText: string): PlannedPhase {
	const trimmed = planText.trim()

	// Empty plan: return a phase with a single empty step.
	if (trimmed === "") {
		return {
			id: "phase-1",
			index: 1,
			name: "",
			goal: "",
			steps: [{ id: "step-1", index: 1, description: "" }],
		}
	}

	// Split on lines starting with "## " (escaped for regex, anchored).
	// Uses a positive lookahead so the heading line itself is not consumed —
	// it is trimmed off explicitly below.
	const parts = trimmed.split(/(?=^##\s+)/mu)

	const steps: PlannedStep[] = []

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]
		const firstLine = part.split("\n")[0]

		// Strip the leading "## " marker.
		const description = part.startsWith("## ") ? part.slice(3).trim() : part.trim()

		// Sections whose first line is a bare "## " with no text are empty after
		// the marker is removed; skip them.
		if (description === "" && firstLine.startsWith("## ")) {
			continue
		}

		// Non-heading leading parts that are also empty should be skipped
		// (the loop above handles this by checking firstLine only when it is
		// a heading; a non-heading part will fall through to the else below).
		if (description === "" && i === 0) {
			continue
		}

		steps.push({
			id: `step-${steps.length + 1}`,
			index: steps.length + 1,
			description,
		})
	}

	// No ## headings found — return single-step phase with entire plan text.
	if (steps.length === 0) {
		const firstNonEmptyLine = trimmed.split("\n").find((l) => l.trim() !== "") ?? ""

		return {
			id: "phase-1",
			index: 1,
			name: firstNonEmptyLine,
			goal: trimmed,
			steps: [{ id: "step-1", index: 1, description: trimmed }],
		}
	}

	// Use the first line of the plan text as the phase title (strip markdown
	// heading markers if present); fall back to empty string.
	const firstLine = trimmed
		.split("\n")[0]
		.replace(/^#+\s*/, "")
		.trim()

	return {
		id: "phase-1",
		index: 1,
		name: firstLine,
		goal: firstLine,
		steps,
	}
}
