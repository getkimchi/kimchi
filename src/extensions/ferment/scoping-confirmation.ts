import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { ScopePhaseInput } from "../../ferment/state-machine.js"
import { normalizeFermentTitle } from "../../ferment/title.js"
import type { FermentRuntime } from "./runtime.js"
import { type ApplyOutcome, createApplyAndPersist } from "./tool-helpers.js"

export type ConfirmPendingScopeSource = "propose_ferment_scoping" | "turn_end"

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
	pi?: ExtensionAPI,
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
						: "No structured phases are pending for this proposal. Call propose_ferment_scoping with the phases included.",
			},
		}
	}

	runtime.consumeScopingGate(fermentId)
	const applyAndPersist = createApplyAndPersist(runtime)
	const previous = runtime.getStorage().get(fermentId)
	const outcome = applyAndPersist(fermentId, {
		type: "scope",
		title: normalizeFermentTitle(pending.title),
		goal: pending.goal,
		successCriteria: pending.successCriteria,
		constraints: pending.constraints,
		assumptions: pending.assumptions,
		phases: scopedPhases,
	})
	if (!outcome.ok) return { ok: false, error: outcome.error }
	runtime.clearPendingScope(fermentId)

	if (pi) {
		runtime.setActive(outcome.ferment)
		if (previous && previous.name !== outcome.ferment.name) {
			const text = `Named ferment "${outcome.ferment.name}" (was "${previous.name}").`
			void pi.sendMessage(
				{
					customType: "ferment_ack",
					content: [{ type: "text", text }],
					display: true,
					details: { text, variant: "ack" },
				},
				{ triggerTurn: false },
			)
		}
	}

	return { ok: true, outcome }
}
