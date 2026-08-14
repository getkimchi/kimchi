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
