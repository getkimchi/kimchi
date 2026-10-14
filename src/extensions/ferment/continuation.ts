import { type DeclarativeAction, determineNextAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import type { ContinuationPolicy } from "./state.js"

type ActivatePhaseAction = Extract<DeclarativeAction, { kind: "activate_phase" }>

// ─── Per-ferment degraded state ───────────────────────────────────────────────

// The continuation policy is process-global (state.ts): one knob shared by every
// ferment in every session of this process. When a ferment's elevation gate is
// declined, that ONE ferment must continue manually — writing the global policy
// would silently stop a concurrent ferment's automated wake-ups (cross-session
// clobber). Degraded ferments are therefore tracked per-id and override the
// session policy at read time.
const degradedFerments = new Set<string>()

/** Mark a ferment as degraded (elevation declined): it continues manually regardless of the session policy. */
export function markFermentDegraded(fermentId: string): void {
	degradedFerments.add(fermentId)
}

export function isFermentDegraded(fermentId: string): boolean {
	return degradedFerments.has(fermentId)
}

/** Drop one ferment's degraded marker — never another ferment's. */
export function clearFermentDegraded(fermentId: string): void {
	degradedFerments.delete(fermentId)
}

/** The continuation policy that actually governs a ferment: a degraded (declined-elevation) ferment always continues manual; everyone else follows the session policy. */
export function effectiveContinuationPolicy(fermentId: string, sessionPolicy: ContinuationPolicy): ContinuationPolicy {
	return degradedFerments.has(fermentId) ? "manual" : sessionPolicy
}

export type ContinuationDecision =
	| { type: "continue"; action: DeclarativeAction }
	| { type: "wait_manual_boundary"; action: ActivatePhaseAction }
	| { type: "paused"; action?: DeclarativeAction }
	| { type: "idle"; action?: DeclarativeAction }

const IDLE_ACTION_KINDS = new Set<DeclarativeAction["kind"]>(["pause", "complete_ferment"])

// Pre-computed variant for treatCompleteFermentAsContinue callers.
const IDLE_ACTION_KINDS_WITHOUT_COMPLETE = new Set([...IDLE_ACTION_KINDS].filter((k) => k !== "complete_ferment"))

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

	const idleKinds = opts.treatCompleteFermentAsContinue ? IDLE_ACTION_KINDS_WITHOUT_COMPLETE : IDLE_ACTION_KINDS

	if (idleKinds.has(action.kind)) {
		return { type: "idle", action }
	}

	// Degraded ferments (declined elevation) continue manually even when the
	// session policy is automated — the policy knob is process-global and must
	// not be flipped for one ferment's decline.
	const effectivePolicy = effectiveContinuationPolicy(ferment.id, policy)

	if (
		effectivePolicy === "manual" &&
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
