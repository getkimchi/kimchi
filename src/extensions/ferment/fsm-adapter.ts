/**
 * FSM Adapter — shared validation helper for ferment tool handlers.
 *
 * Provides a consistent interface for validating FSM transitions before
 * executing state-mutating operations.
 */

import { type DeclarativeAction, determineNextAction } from "../../ferment/engine.js"
import {
	FSM_EVENTS,
	FSM_STATES,
	type FermentFsmContext,
	type FsmState,
	fermentStatusToFsmState,
	transition,
} from "../../ferment/fsm.js"
import type { Ferment } from "../../ferment/types.js"
import { publicToolNameForActionKind } from "./action-tool-names.js"

// ─── FSM State Computation ────────────────────────────────────────────────────

/**
 * Compute the actual FSM state from a Ferment.
 *
 * Unlike fermentStatusToFsmState which does a simple 1:1 mapping, this function
 * correctly handles STEP_RUNNING state by checking if any step is in "running" status.
 *
 * The FSM distinguishes between:
 * - PHASE_ACTIVE: ferment status is "running" and no step is currently running
 * - STEP_RUNNING: ferment status is "running" and a step IS currently running
 */
export function computeFsmState(ferment: Ferment): FsmState {
	const baseState = fermentStatusToFsmState(ferment.status)

	// If not in PHASE_ACTIVE, just return the base state
	if (baseState !== FSM_STATES.PHASE_ACTIVE) return baseState

	// Check if any step is currently running
	const hasRunningStep = ferment.phases.some((p) => p.steps.some((s) => s.status === "running"))

	return hasRunningStep ? FSM_STATES.STEP_RUNNING : FSM_STATES.PHASE_ACTIVE
}

// ─── FSM Context Builder ──────────────────────────────────────────────────────

/**
 * Build an FSM context from a Ferment for transition validation.
 */
export function buildFsmContext(f: Ferment): FermentFsmContext {
	return {
		fermentStatus: f.status,
		activePhaseId: f.activePhaseId,
		phases: f.phases.map((p) => ({
			id: p.id,
			index: p.index,
			name: p.name,
			status: p.status,
			groupIndex: p.groupIndex,
			steps: p.steps.map((s) => ({
				id: s.id,
				index: s.index,
				description: s.description,
				status: s.status,
				parallel: s.parallel ?? false,
				groupIndex: s.groupIndex,
			})),
		})),
	}
}

// ─── Validation Result ────────────────────────────────────────────────────────

export interface FsmValidationResult {
	error?: string
}

// ─── Main Validation Function ─────────────────────────────────────────────────

/**
 * Validate an FSM transition and return error message if invalid.
 *
 * @param ferment - The ferment to validate against
 * @param event - The FSM event type to validate
 * @param params - Event parameters (phaseId, stepId, etc.)
 * @returns FsmValidationResult with error field if validation failed
 */
export function validateFsmTransitionWithFerment(
	ferment: Ferment | undefined | null,
	event: keyof typeof FSM_EVENTS,
	params: { phaseId?: string; stepId?: string } = {},
): FsmValidationResult {
	if (!ferment) {
		return { error: "Ferment not found." }
	}

	const currentState = computeFsmState(ferment)
	const ctx = buildFsmContext(ferment)
	const result = transition(currentState, FSM_EVENTS[event], ctx, params)

	if (!result.error) return {}
	const suggestion = formatNextActionSuggestion(determineNextAction(ferment))
	return { error: suggestion ? `${result.error} ${suggestion}` : result.error }
}

function formatNextActionSuggestion(action: DeclarativeAction | undefined): string {
	if (!action) return ""
	const refs: string[] = []
	if ("phaseId" in action) refs.push(`phaseId=${action.phaseId}`)
	if ("stepId" in action) refs.push(`stepId=${action.stepId}`)
	const refSuffix = refs.length ? ` (${refs.join(", ")})` : ""
	return `Recommended next action: ${publicToolNameForActionKind(action.kind)}${refSuffix} — ${action.reason}.`
}
