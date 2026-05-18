/**
 * Single state-derivation function — `deriveFermentState`.
 *
 * Reads a Ferment + runtime state (block retries, corrective steps, after-scope
 * continuation, git refs) and returns a structured "what's going on, what's
 * next" snapshot. Pure function: no side effects, no I/O beyond what the
 * runtime reader already does (sidecar reads via state.ts hydration are
 * effectively transparent).
 *
 * Why: today the answer to "where is this ferment?" is scattered across
 * `computeFsmState` + `determineNextAction` + several `runtime.getX(...)`
 * calls. This module is the single read path. Tool handlers and nudge logic
 * can opt into reading the rich struct in follow-up refactors; this commit is
 * additive.
 *
 * Pairs with:
 *   - state.ts          (persisted runtime state, lazily hydrated)
 *   - engine.ts         (determineNextAction — what the agent should do next)
 *   - fsm-adapter.ts    (computeFsmState — current FSM cell)
 *
 * Not consumed yet by tool handlers or prompt-block.ts — those still read
 * their specific bits. The function is provided so future debug/status
 * commands can converge on a single source of truth.
 */

import { type DeclarativeAction, determineNextAction } from "../../ferment/engine.js"
import type { FsmState } from "../../ferment/fsm.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { computeFsmState } from "./fsm-adapter.js"
import { MAX_BLOCK_RETRIES } from "./state.js"

/** Subset of FermentRuntime the derivation function reads. Structural typing
 *  lets callers pass either the full runtime or a test mock. */
export interface RuntimeReader {
	getBlockRetry(fermentId: string, phaseId: string): number
	getPhaseStartRef(fermentId: string, phaseId: string): string | undefined
	getStepStartRef(fermentId: string, phaseId: string, stepId: string): string | undefined
}

/** Slim phase descriptor for embedding in DerivedFermentState. */
export interface DerivedPhase {
	id: string
	name: string
	goal: string
	index: number
}

/** Slim step descriptor for embedding in DerivedFermentState. */
export interface DerivedStep {
	id: string
	description: string
	verifyCommand?: string
	index: number
}

export interface PhaseRetryBudget {
	phaseId: string
	used: number
	max: number
	/** True when used >= max — one more block-flagged complete_ferment_phase call will
	 *  trigger escalation (or has already). */
	atRiskOfEscalation: boolean
}

export interface DerivedFermentState {
	/** Current FSM cell. Same value `computeFsmState` returns. */
	fsmState: FsmState
	/** What the agent should do next. Absent when no lifecycle action remains. */
	nextAction?: DeclarativeAction
	/** The phase currently active (status === "active"), if any. */
	activePhase?: DerivedPhase
	/** The step currently running (status === "running") in the active phase. */
	activeStep?: DerivedStep
	/** Retry budget for the active phase — only present when retries have been
	 *  used. `at_risk` callers can surface this in prompts / dashboards. */
	phaseRetry?: PhaseRetryBudget
	/** Git refs captured at activate_ferment_phase / start_ferment_step. Available even after
	 *  a restart thanks to Step B persistence. */
	phaseStartRef?: string
	stepStartRef?: string
	/** Set when the state effectively prevents the agent from proceeding (e.g.
	 *  paused, abandoned, complete). Carries a human-readable explanation. */
	blocked?: { reason: string; recoveryHint?: string }
}

function describePhase(phase: Phase): DerivedPhase {
	return { id: phase.id, name: phase.name, goal: phase.goal, index: phase.index }
}

function describeStep(step: Step): DerivedStep {
	return {
		id: step.id,
		description: step.description,
		verifyCommand: step.verification?.command,
		index: step.index,
	}
}

function blockedReason(ferment: Ferment): { reason: string; recoveryHint?: string } | undefined {
	switch (ferment.status) {
		case "paused":
			return {
				reason: "Ferment is paused.",
				recoveryHint: "Resume with /ferment resume or activate_ferment_phase after the issue is addressed.",
			}
		case "abandoned":
			return {
				reason: "Ferment was abandoned and cannot proceed.",
				recoveryHint: "Create a new ferment with /ferment new or /ferment one-shot.",
			}
		case "complete":
			return {
				reason: "Ferment is complete — no further action.",
			}
		default:
			return undefined
	}
}

/** Derive a structured snapshot of where the ferment is and what should
 *  happen next. Pure read — no mutations, no I/O beyond the runtime
 *  reader's existing hydration. */
export function deriveFermentState(ferment: Ferment, runtime: RuntimeReader): DerivedFermentState {
	const fsmState = computeFsmState(ferment)
	const nextAction = determineNextAction(ferment)

	const activePhaseObj = ferment.phases.find((p) => p.status === "active")
	const activeStepObj = activePhaseObj?.steps.find((s) => s.status === "running")

	const result: DerivedFermentState = { fsmState }
	if (nextAction) result.nextAction = nextAction

	if (activePhaseObj) {
		result.activePhase = describePhase(activePhaseObj)
		const ref = runtime.getPhaseStartRef(ferment.id, activePhaseObj.id)
		if (ref) result.phaseStartRef = ref
		const retries = runtime.getBlockRetry(ferment.id, activePhaseObj.id)
		if (retries > 0) {
			result.phaseRetry = {
				phaseId: activePhaseObj.id,
				used: retries,
				max: MAX_BLOCK_RETRIES,
				atRiskOfEscalation: retries >= MAX_BLOCK_RETRIES,
			}
		}
	}

	if (activePhaseObj && activeStepObj) {
		result.activeStep = describeStep(activeStepObj)
		const stepRef = runtime.getStepStartRef(ferment.id, activePhaseObj.id, activeStepObj.id)
		if (stepRef) result.stepStartRef = stepRef
	}

	const blocked = blockedReason(ferment)
	if (blocked) result.blocked = blocked

	return result
}
