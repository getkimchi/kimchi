// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { Ferment } from "../../ferment/types.js"
import type { FermentStalledPayload } from "./domain-events.js"

/** Build the shared telemetry payload for every Ferment stall detection path. */
export function buildStalledPayload(ferment: Ferment, now: number): FermentStalledPayload {
	const completedPhases = ferment.phases.filter((phase) => phase.status === "completed").length
	const totalPhases = ferment.phases.length
	const phaseCompletionRatio = totalPhases > 0 ? completedPhases / totalPhases : 0
	const lastActiveMs = ferment.lastActiveAt ? Date.parse(ferment.lastActiveAt) : Number.NaN
	const idleDurationMs = Number.isFinite(lastActiveMs) ? now - lastActiveMs : 0
	return {
		fermentId: ferment.id,
		name: ferment.name,
		lifecycleStage: ferment.status,
		idleDurationMs,
		completedPhases,
		totalPhases,
		phaseCompletionRatio,
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
