/**
 * Lifecycle obligation guard.
 *
 * Detects when the model ends an assistant turn with no tool calls while
 * persisted Ferment state still requires a concrete lifecycle transition.
 * Instead of silently disappearing (the current reactive-nudge path has a
 * budget of one, keyed only by Ferment ID and reset on any tool call), this
 * guard tracks retries per *obligation* — identified by the action kind +
 * phase/step IDs — so an unrelated `read`/`grep` call does not silently
 * replenish the budget for an unchanged obligation.
 *
 * The guard is **automated-only**. It fires only when
 * `runtime.isAutomatedContinuationEnabled()` is true. In interactive mode
 * the user is present to steer; firing a lifecycle nudge during a legitimate
 * model-to-user conversation would be disruptive. Interactive coverage is
 * deferred until `maybeRunUserInputDropdown` detection is proven sufficient
 * to distinguish legitimate conversation stops from lifecycle stalls.
 *
 * The guard never applies a state transition itself. It schedules another
 * model turn via `scheduleNextFermentAction` (steer delivery); it never
 * calls `createApplyAndPersist`. When retries are exhausted it emits one
 * visible `ferment_breadcrumb` + `FERMENT_EVENTS.STALLED` telemetry and
 * leaves persisted state intact.
 *
 * Separation of concerns:
 *
 *   persisted Ferment state
 *           ↓
 *   determineNextAction / continuation policy
 *           ↓
 *   declarative lifecycle obligation
 *           ↓
 *   model emits corresponding lifecycle tool call
 *           ↓
 *   tool validates and persists the transition
 *
 * The guard belongs between action derivation and the model's next
 * opportunity to call the tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { DeclarativeAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { decideContinuation } from "./continuation.js"
import { FERMENT_EVENTS, type FermentStalledPayload } from "./domain-events.js"
import { refreshActiveFermentFromStorage } from "./nudge.js"
import type { FermentRuntime } from "./runtime.js"
import { safeSendMessage } from "./safe-send.js"
import { scheduleNextFermentAction } from "./scheduler.js"
import { FERMENT_TOOLS } from "./tool-names.js"

// ─── Retry budget ─────────────────────────────────────────────────────────────

/**
 * Maximum retries after the original invalid stop. The model receives at most
 * three total opportunities for one unchanged obligation:
 *
 *   original response: empty tool calls
 *   retry 1:           scheduled by guard
 *   retry 2:           scheduled by guard
 *   then:              explicit exhaustion diagnostic
 */
export const MAX_LIFECYCLE_STOP_RETRIES = 2

// ─── Obligation identity ──────────────────────────────────────────────────────

export interface LifecycleObligation {
	/** Stable key: fermentId + action.kind + phaseId? + stepId? */
	key: string
	action: DeclarativeAction
	/** The public tool name the model should call, or undefined for non-forced actions. */
	toolName?: string
}

export type LifecycleGuardDecision =
	| { type: "none" }
	| { type: "retry"; obligation: LifecycleObligation; attempt: number; maxAttempts: number }
	| { type: "exhausted"; obligation: LifecycleObligation; attempts: number; report: boolean }

/**
 * Actions that represent a single forced tool obligation. The guard will
 * schedule a retry naming this exact tool.
 *
 * `recover_step` and `recover_phase` are intentionally excluded: they have
 * several legal choices (retry vs. skip vs. abandon) and the guard must not
 * claim one exact tool is mandatory.
 */
const CONCRETE_OBLIGATION_KINDS = new Set<DeclarativeAction["kind"]>([
	"scope",
	"activate_phase",
	"refine",
	"start_step",
	"complete_step",
	"verify_step",
	"complete_phase",
	"complete_ferment",
])

/**
 * Maps a declarative action kind to the public tool name the model must call.
 * Returns undefined for actions that are not a single forced tool obligation
 * (recover_step, recover_phase, pause, or no action).
 */
function toolNameForAction(action: DeclarativeAction): string | undefined {
	switch (action.kind) {
		case "scope":
			return FERMENT_TOOLS.SCOPE
		case "activate_phase":
			return FERMENT_TOOLS.ACTIVATE_PHASE
		case "refine":
			return FERMENT_TOOLS.REFINE_PHASE
		case "start_step":
			return FERMENT_TOOLS.START_STEP
		case "complete_step":
			return FERMENT_TOOLS.COMPLETE_STEP
		case "verify_step":
			return FERMENT_TOOLS.VERIFY_STEP
		case "complete_phase":
			return FERMENT_TOOLS.COMPLETE_PHASE
		case "complete_ferment":
			return FERMENT_TOOLS.COMPLETE
		default:
			return undefined
	}
}

/**
 * Builds a stable obligation key from the ferment ID and the action's concrete
 * identifiers. Two stops for the same key consume the same budget; a different
 * key (state advancement, phase/step switch) receives a fresh budget.
 */
export function buildObligationKey(fermentId: string, action: DeclarativeAction): string {
	const parts = [fermentId, action.kind]
	if ("phaseId" in action) parts.push(action.phaseId)
	if ("stepId" in action) parts.push(action.stepId)
	return parts.join(":")
}

/**
 * Derives the current lifecycle obligation from a ferment, or undefined if
 * no concrete obligation exists. Uses `decideContinuation` with
 * `treatCompleteFermentAsContinue: true` so final completion is treated as
 * a continuable action (consistent with the existing
 * `maybeInjectFermentStopNudge` path).
 */
export function deriveObligation(ferment: Ferment, policy: "automated" | "manual"): LifecycleObligation | undefined {
	// Guard is automated-only.
	if (policy !== "automated") return undefined

	const decision = decideContinuation(ferment, policy, { treatCompleteFermentAsContinue: true })
	if (decision.type !== "continue") return undefined

	const action = decision.action
	if (!CONCRETE_OBLIGATION_KINDS.has(action.kind)) return undefined

	const toolName = toolNameForAction(action)
	if (!toolName) return undefined

	return {
		key: buildObligationKey(ferment.id, action),
		action,
		toolName,
	}
}

// ─── Retry tracker ────────────────────────────────────────────────────────────
//
// Session-memory storage (matches the existing nudge counters in nudge.ts).
// Not persisted to the Ferment event store — this is an agent-loop recovery
// budget, not domain progress. Replay must not change domain state.

interface RetryState {
	/** Number of retries scheduled so far for this key (0 after first stop). */
	count: number
	/** Whether exhaustion has already been reported for this key. */
	reported: boolean
}

/**
 * Per-ferment retry state, keyed by obligation key. Old keys for a ferment
 * are pruned when a new current key is observed so the map does not grow
 * for the life of a long Ferment.
 *
 * Outer map: fermentId → (obligationKey → RetryState)
 */
const retryStates = new Map<string, Map<string, RetryState>>()

function getFermentMap(fermentId: string): Map<string, RetryState> {
	let m = retryStates.get(fermentId)
	if (!m) {
		m = new Map()
		retryStates.set(fermentId, m)
	}
	return m
}

/**
 * Prunes old obligation keys for a ferment, keeping only the current key.
 * Called when a new current key is observed so the map does not grow
 * unboundedly for a long Ferment.
 */
function pruneOldKeys(fermentId: string, currentKey: string): void {
	const m = retryStates.get(fermentId)
	if (!m) return
	for (const key of m.keys()) {
		if (key !== currentKey) m.delete(key)
	}
}

/**
 * Clears all retry state for a ferment. Called on abort, error, pause,
 * complete, abandon, session shutdown, and successful lifecycle tool calls
 * that change the obligation key.
 */
export function clearLifecycleGuard(fermentId: string): void {
	retryStates.delete(fermentId)
}

/** Clears all retry state for all ferments. Used by tests and session reset. */
export function clearAllLifecycleGuards(): void {
	retryStates.clear()
}

/**
 * Evaluates a zero-tool assistant turn and decides whether to schedule a
 * retry, report exhaustion, or do nothing.
 *
 * Pure: does not call any pi API. The caller owns the scheduling side effects.
 */
export function evaluateLifecycleStop(obligation: LifecycleObligation): LifecycleGuardDecision {
	// Ferment IDs are generated UUIDs, so the first key segment is stable.
	const fermentId = obligation.key.split(":")[0]
	const m = getFermentMap(fermentId)
	pruneOldKeys(fermentId, obligation.key)

	const state = m.get(obligation.key)
	if (!state) {
		// First stop for this obligation.
		m.set(obligation.key, { count: 1, reported: false })
		return { type: "retry", obligation, attempt: 1, maxAttempts: MAX_LIFECYCLE_STOP_RETRIES }
	}

	const newCount = state.count + 1
	if (newCount <= MAX_LIFECYCLE_STOP_RETRIES) {
		m.set(obligation.key, { count: newCount, reported: false })
		return { type: "retry", obligation, attempt: newCount, maxAttempts: MAX_LIFECYCLE_STOP_RETRIES }
	}

	// Budget exhausted.
	if (state.reported) {
		return { type: "exhausted", obligation, attempts: newCount, report: false }
	}
	m.set(obligation.key, { count: newCount, reported: true })
	return { type: "exhausted", obligation, attempts: newCount, report: true }
}

// ─── Pi-dependent wrapper ─────────────────────────────────────────────────────

export interface LifecycleGuardCallbacks {
	/** Called when a `complete_ferment` retry is scheduled, so `agent_end`
	 *  does not schedule a duplicate. Same latch as
	 *  `maybeInjectFermentStopNudge`. */
	onFinalCompletionNudgeScheduled?: () => void
}

function buildRetryInstruction(
	ferment: Ferment,
	obligation: LifecycleObligation,
	attempt: number,
	maxAttempts: number,
): string {
	const toolName = obligation.toolName ?? obligation.action.kind
	const actionSpecificReminder =
		obligation.action.kind === "scope"
			? " Include the complete plan and exactly the P1/P2/P3 gate verdicts; do not fabricate missing values."
			: obligation.action.kind === "complete_step"
				? " Call it only after the linked worker has a completed outcome and completed report."
				: ""

	if (attempt === 1) {
		return `Ferment "${ferment.name}" still requires ${toolName}. The previous turn stopped without a tool call. Call ${toolName} now using the required Ferment/phase/step identifiers and payload.${actionSpecificReminder}`
	}

	return `Lifecycle action still pending (retry ${attempt}/${maxAttempts}). Do not respond with an announcement or summary. Emit the required ${toolName} call now. If the action cannot safely be performed, use the appropriate user-input or recovery mechanism instead of stopping silently.${actionSpecificReminder}`
}

/**
 * Detects whether the just-ended assistant turn was a bare stop that leaves
 * a lifecycle obligation unmet, and either schedules a retry or reports
 * exhaustion.
 *
 * Returns true if the guard acted (scheduled a retry or emitted an
 * exhaustion diagnostic), false if it did nothing (caller should fall
 * through to existing handling).
 *
 * Prerequisites the caller must guarantee:
 * - The message role is `assistant`.
 * - The turn was not aborted or errored (handled by early returns).
 * - The assistant content contains zero `toolCall` parts.
 * - No pending plan review is suppressing tools.
 * - The turn was not handled as a legitimate user-input question or manual boundary.
 *
 * The guard itself re-checks: automated policy, active ferment existence,
 * terminal/paused status, and concrete obligation presence.
 */
export function maybeInjectLifecycleObligationGuard(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
	callbacks?: LifecycleGuardCallbacks,
): boolean {
	if (!runtime.isAutomatedContinuationEnabled()) return false

	const id = runtime.getActiveId()
	if (!id) return false

	const fresh = refreshActiveFermentFromStorage(runtime)
	const inactive = !fresh || fresh.status === "complete" || fresh.status === "abandoned"
	if (inactive) {
		runtime.setActive(undefined)
	}
	if (inactive || fresh.status === "paused") {
		clearLifecycleGuard(id)
		return false
	}

	const obligation = deriveObligation(fresh, runtime.getContinuationPolicy())
	if (!obligation) return false

	const decision = evaluateLifecycleStop(obligation)

	if (decision.type === "retry") {
		scheduleNextFermentAction(pi, fresh, runtime, {
			tag: `Lifecycle guard retry ${decision.attempt}/${decision.maxAttempts}`,
			deliverAs: "steer",
			treatCompleteFermentAsContinue: true,
			messagePrefix: buildRetryInstruction(fresh, decision.obligation, decision.attempt, decision.maxAttempts),
		})
		if (decision.obligation.action.kind === "complete_ferment") {
			callbacks?.onFinalCompletionNudgeScheduled?.()
		}
		return true
	}

	if (decision.type === "exhausted" && decision.report) {
		const action = decision.obligation.action
		const toolName = decision.obligation.toolName ?? action.kind
		const breadcrumbText = `Lifecycle guard exhausted for "${fresh.name}": required action "${action.kind}" (tool: ${toolName}) was not called after ${MAX_LIFECYCLE_STOP_RETRIES} lifecycle-stop retries (${decision.attempts} consecutive text-only stops). No state transition was applied automatically.`

		safeSendMessage(
			pi,
			{
				customType: "ferment_breadcrumb",
				content: [{ type: "text", text: breadcrumbText }],
				display: true,
				details: { text: breadcrumbText, variant: "warning" },
			},
			{ triggerTurn: false },
		)

		// Emit stalled telemetry. Reuse the existing payload shape — the
		// guard's stall is the same class of failure as a crash-recovery
		// stall, just detected at a different point.
		const stalledPayload: FermentStalledPayload = buildStalledPayload(fresh, runtime.now().getTime())
		runtime.events?.emit(FERMENT_EVENTS.STALLED, stalledPayload)

		return true
	}

	// exhausted but already reported — do nothing, do not schedule.
	if (decision.type === "exhausted") {
		return true
	}

	return false
}

function buildStalledPayload(ferment: Ferment, now: number): FermentStalledPayload {
	const completedPhases = ferment.phases.filter((p) => p.status === "completed").length
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
