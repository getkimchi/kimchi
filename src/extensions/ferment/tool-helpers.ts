/**
 * Tool result builders + entity resolvers shared across tool implementations.
 */

import type { Ferment, Phase, Step } from "../../ferment/types.js"

// ─── Tool result builders ─────────────────────────────────────────────────────
// Every tool execute returns the same { details, content, isError? } shape;
// these helpers cut the visual noise.

export function toolOk(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }] }
}

export function toolErr(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }], isError: true }
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

/** Resolve a phase by exact id → name substring → active phase. */
export function resolvePhase(f: Ferment, phaseId: string): Phase | undefined {
	let phase = f.phases.find((p) => p.id === phaseId)
	if (!phase) {
		const needle = phaseId.toLowerCase()
		phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
	}
	if (!phase) {
		phase = f.phases.find((p) => p.status === "active")
	}
	return phase
}

/** Resolve a step by exact id → step-N index format. */
export function resolveStep(phase: Phase, stepId: string): Step | undefined {
	let step = phase.steps.find((s) => s.id === stepId)
	if (!step) {
		const idxMatch = stepId.match(/(\d+)$/)
		if (idxMatch) {
			const idx = Number.parseInt(idxMatch[1], 10)
			step = phase.steps.find((s) => s.index === idx)
		}
	}
	return step
}
