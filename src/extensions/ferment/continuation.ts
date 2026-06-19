import { type DeclarativeAction, determineNextAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import type { ContinuationPolicy } from "./state.js"

type ActivatePhaseAction = Extract<DeclarativeAction, { kind: "activate_phase" }>

export type ContinuationDecision =
	| { type: "continue"; action: DeclarativeAction }
	| { type: "wait_manual_boundary"; action: ActivatePhaseAction }
	| { type: "paused"; action?: DeclarativeAction }
	| { type: "idle"; action?: DeclarativeAction }

const IDLE_ACTION_KINDS = new Set<DeclarativeAction["kind"]>(["pause", "complete_ferment"])

export function decideContinuation(
	ferment: Ferment,
	policy: ContinuationPolicy,
	opts: { allowManualPhaseBoundary?: boolean; treatCompleteFermentAsContinue?: boolean } = {},
): ContinuationDecision {
	const action = determineNextAction(ferment)

	if (ferment.status === "paused") {
		return { type: "paused", action }
	}

	if (!action) {
		return { type: "idle" }
	}

	const idleKinds = opts.treatCompleteFermentAsContinue
		? new Set([...IDLE_ACTION_KINDS].filter((k) => k !== "complete_ferment"))
		: IDLE_ACTION_KINDS

	if (idleKinds.has(action.kind)) {
		return { type: "idle", action }
	}

	if (
		policy === "manual" &&
		action.kind === "activate_phase" &&
		isManualPhaseBoundary(ferment, action) &&
		!opts.allowManualPhaseBoundary
	) {
		return { type: "wait_manual_boundary", action }
	}

	return { type: "continue", action }
}

export function isManualPhaseBoundary(ferment: Ferment, action: ActivatePhaseAction): boolean {
	const targetPhase = ferment.phases.find((phase) => phase.id === action.phaseId)
	if (!targetPhase) return true
	return ferment.phases.some(
		(phase) =>
			phase.index < targetPhase.index &&
			(phase.status === "completed" || phase.status === "skipped" || phase.status === "failed"),
	)
}
