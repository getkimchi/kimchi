import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import type { FermentRuntime } from "./runtime.js"
import { type ApplyOutcome, createApplyAndPersist } from "./tool-helpers.js"

export type ConfirmPendingScopeSource = "propose_phases" | "turn_end"

export type ConfirmPendingScopeResult =
	| { ok: true; outcome: Extract<ApplyOutcome, { ok: true }> }
	| {
			ok: false
			error:
				| Extract<ApplyOutcome, { ok: false }>["error"]
				| { code: "MISSING_PENDING_SCOPE"; message: string }
				| { code: "MISSING_PENDING_PHASES"; message: string }
	  }

export function confirmPendingScope(
	runtime: FermentRuntime,
	fermentId: string,
	phases: ScopePhaseInput[] | undefined,
	source: ConfirmPendingScopeSource,
	title?: string,
): ConfirmPendingScopeResult {
	const pending = runtime.getPendingScope(fermentId)
	if (!pending) {
		return {
			ok: false,
			error: {
				code: "MISSING_PENDING_SCOPE",
				message: `No pending scope for ferment "${fermentId}".`,
			},
		}
	}

	const scopedPhases = phases ?? pending.phases
	if (!scopedPhases || scopedPhases.length === 0) {
		return {
			ok: false,
			error: {
				code: "MISSING_PENDING_PHASES",
				message:
					source === "turn_end"
						? "User confirmed the plan but no structured phases are pending."
						: "No structured phases are pending for this proposal.",
			},
		}
	}

	runtime.consumeScopingGate(fermentId)
	const applyAndPersist = createApplyAndPersist(runtime)
	const outcome = applyAndPersist(fermentId, {
		type: "scope",
		title,
		goal: pending.goal,
		successCriteria: pending.successCriteria,
		constraints: pending.constraints,
		phases: scopedPhases,
	})
	if (!outcome.ok) return { ok: false, error: outcome.error }
	runtime.clearPendingScope(fermentId)
	return { ok: true, outcome }
}
