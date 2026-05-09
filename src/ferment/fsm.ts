/**
 * Ferment Finite State Machine — Declarative FSM with Guards & Actions
 *
 * This module implements a proper finite state machine for the ferment system,
 * providing:
 * - Declarative state machine config (XState-style) for visualization
 * - Pure transition functions with guards
 * - Action computation (what to do next)
 *
 * States:
 *   IDLE → DRAFT → SCOPING → PLANNED → PHASE_ACTIVE → STEP_RUNNING → [terminal]
 *                ↘         ↘           ↘
 *                ABANDONED  PAUSED     PAUSED
 *                                     ↘           ↘
 *                                     COMPLETE    ABANDONED
 *
 * The FSM operates on a FermentFsmContext (snapshot of relevant ferment fields)
 * rather than the full Ferment to keep transitions pure and testable.
 */

import type { FermentStatus, PhaseStatus, StepStatus } from "./types.js"

// ─── FSM States ───────────────────────────────────────────────────────────────

export const FSM_STATES = {
	IDLE: "IDLE",
	DRAFT: "DRAFT",
	SCOPING: "SCOPING",
	PLANNED: "PLANNED",
	PHASE_ACTIVE: "PHASE_ACTIVE",
	STEP_RUNNING: "STEP_RUNNING",
	PAUSED: "PAUSED",
	COMPLETE: "COMPLETE",
	ABANDONED: "ABANDONED",
} as const

export type FsmState = (typeof FSM_STATES)[keyof typeof FSM_STATES]

// ─── FSM Events ───────────────────────────────────────────────────────────────

export const FSM_EVENTS = {
	CREATE_FERMENT: "create_ferment",
	SCOPE_FERMENT: "scope_ferment",
	SET_MODE: "set_mode",
	ACTIVATE_PHASE: "activate_phase",
	REFINE_PHASE: "refine_phase",
	COMPLETE_PHASE: "complete_phase",
	SKIP_PHASE: "skip_phase",
	FAIL_PHASE: "fail_phase",
	START_STEP: "start_step",
	COMPLETE_STEP: "complete_step",
	VERIFY_STEP: "verify_step",
	SKIP_STEP: "skip_step",
	FAIL_STEP: "fail_step",
	PAUSE: "pause",
	RESUME: "resume",
	SET_STEP_GRADE: "set_step_grade",
	SET_PHASE_GRADE: "set_phase_grade",
	SET_FERMENT_GRADE: "set_ferment_grade",
	ABANDON: "abandon",
} as const

export type FsmEvent = (typeof FSM_EVENTS)[keyof typeof FSM_EVENTS]

// Internal events (not exposed as public API)
const INTERNAL_EVENTS = {
	COMPLETE_FERMENT: "complete_ferment",
	RESUME__PLANNED: "resume__planned",
	COMPLETE_PHASE__NEXT: "complete_phase__next",
} as const

export type InternalEvent = (typeof INTERNAL_EVENTS)[keyof typeof INTERNAL_EVENTS]

// All valid events including internal ones
export type AnyEvent = FsmEvent | InternalEvent

// ─── FSM Context — Minimal ferment snapshot for deterministic transitions ─────

export interface PhaseContext {
	id: string
	index: number
	name: string
	status: PhaseStatus
	groupIndex?: number
	steps: StepContext[]
}

export interface StepContext {
	id: string
	index: number
	description: string
	status: StepStatus
	canRunParallel: boolean
}

export interface FermentFsmContext {
	/** FSM maps FermentStatus to FsmState */
	fermentStatus: FermentStatus
	activePhaseId?: string
	phases: PhaseContext[]
}

// ─── Transition Result ────────────────────────────────────────────────────────

export interface FsmTransitionResult {
	state: FsmState
	error?: string
	action?: FsmAction
}

export interface FsmAction {
	type: AnyEvent
	phaseId?: string
	stepId?: string
	message: string
}

// ─── Guard Functions ──────────────────────────────────────────────────────────

type GuardFn = (ctx: FermentFsmContext, params: EventParams) => string | null
type ActionFn = (ctx: FermentFsmContext, params: EventParams) => FsmAction

const GUARD_ERRORS = {
	INVALID_STATUS: (expected: string, actual: string) =>
		`Invalid ferment status: expected ${expected}, got "${actual}".`,
	PHASE_NOT_FOUND: (id: string) => `Phase "${id}" not found.`,
	PHASE_NOT_ACTIVE: (id: string, status: PhaseStatus) => `Phase "${id}" is "${status}", expected "active".`,
	STEP_NOT_FOUND: (id: string, phaseId: string) => `Step "${id}" not found in phase "${phaseId}".`,
	STEP_NOT_RUNNING: (id: string, status: StepStatus) => `Step "${id}" is "${status}", expected "running".`,
	CONCURRENT_STEP: (runningId: string) =>
		`Cannot start new step — step "${runningId}" is already running (non-parallel).`,
	PARALLEL_GROUP_BLOCKED: (ids: string[]) =>
		`Parallel group has non-terminal phases: ${ids.join(", ")}. Complete all before proceeding.`,
	NO_PHASES: "No phases defined. Add phases before activating.",
	NO_ACTIVE_PHASE: "No active phase. Activate a phase first.",
	ALREADY_PAUSED: "Ferment is already paused.",
	NOT_PAUSED: "Ferment is not paused. Only paused ferments can resume.",
	ALL_COMPLETE: "All phases are terminal. Ferment is complete.",
} as const

function requireFermentStatus(ctx: FermentFsmContext, expected: FermentStatus[]): string | null {
	if (expected.includes(ctx.fermentStatus)) return null
	const expectedStr = expected.map((s) => `"${s}"`).join(" or ")
	return GUARD_ERRORS.INVALID_STATUS(expectedStr, ctx.fermentStatus)
}

function requireActivePhase(ctx: FermentFsmContext): PhaseContext | string {
	if (!ctx.activePhaseId) return GUARD_ERRORS.NO_ACTIVE_PHASE
	const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
	if (!phase) return GUARD_ERRORS.PHASE_NOT_FOUND(ctx.activePhaseId)
	if (phase.status !== "active") return GUARD_ERRORS.PHASE_NOT_ACTIVE(phase.id, phase.status)
	return phase
}

function findPhaseById(ctx: FermentFsmContext, phaseId: string): PhaseContext | string {
	const phase = ctx.phases.find((p) => p.id === phaseId)
	if (!phase) return GUARD_ERRORS.PHASE_NOT_FOUND(phaseId)
	return phase
}

function findStepInPhase(phase: PhaseContext, stepId: string): StepContext | string {
	const step = phase.steps.find((s) => s.id === stepId)
	if (!step) return GUARD_ERRORS.STEP_NOT_FOUND(stepId, phase.id)
	return step
}

function hasNonParallelRunningStep(ctx: FermentFsmContext, newStepId: string): string | null {
	const activePhase =
		typeof requireActivePhase(ctx) === "string" ? null : ctx.phases.find((p) => p.id === ctx.activePhaseId)
	if (!activePhase) return null

	const runningStep = activePhase.steps.find((s) => s.status === "running" && s.id !== newStepId)
	if (!runningStep) return null

	// Allow if both steps can run in parallel
	const newStep = activePhase.steps.find((s) => s.id === newStepId)
	if (runningStep.canRunParallel && newStep?.canRunParallel) return null

	return GUARD_ERRORS.CONCURRENT_STEP(runningStep.id)
}

function checkParallelGroupComplete(ctx: FermentFsmContext, phase: PhaseContext): string | null {
	if (phase.groupIndex === undefined) return null

	const groupPhases = ctx.phases.filter((p) => p.groupIndex === phase.groupIndex)
	const nonTerminal = groupPhases.filter((p) => !isPhaseTerminal(p))

	if (nonTerminal.length > 0) {
		return GUARD_ERRORS.PARALLEL_GROUP_BLOCKED(nonTerminal.map((p) => p.id))
	}
	return null
}

function isPhaseTerminal(phase: PhaseContext): boolean {
	return phase.status === "completed" || phase.status === "skipped" || phase.status === "failed"
}

function areAllPhasesTerminal(ctx: FermentFsmContext): boolean {
	return ctx.phases.length > 0 && ctx.phases.every((p) => isPhaseTerminal(p))
}

// ─── Event Parameters ─────────────────────────────────────────────────────────

export interface EventParams {
	phaseId?: string
	stepId?: string
	mode?: string
}

// ─── Transition Entry ─────────────────────────────────────────────────────────

interface TransitionEntry {
	target: FsmState | ((ctx: FermentFsmContext) => FsmState)
	guard?: string // guard name
	action?: string // action name
}

type TransitionMap = Partial<Record<FsmState, Partial<Record<string, TransitionEntry>>>>

// ─── FSM Configuration (XState-style declarative config) ─────────────────────

export const fsmConfig = {
	id: "ferment",
	initial: "IDLE",
	states: {
		IDLE: {
			on: {
				CREATE_FERMENT: { target: "DRAFT" },
			},
		},
		DRAFT: {
			on: {
				SCOPE_FERMENT: { target: "PLANNED", guard: "hasPhases" },
				SET_MODE: { target: "DRAFT" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		SCOPING: {
			on: {
				SCOPE_FERMENT: { target: "PLANNED" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		PLANNED: {
			on: {
				ACTIVATE_PHASE: {
					target: "PHASE_ACTIVE",
					guard: "phaseExistsAndPlanned",
					action: "suggestRefineOrStartStep",
				},
				REFINE_PHASE: { target: "PLANNED" },
				SKIP_PHASE: { target: "PLANNED", action: "suggestActivateNextPhase" },
				SCOPE_FERMENT: { target: "PLANNED" },
				SET_MODE: { target: "PLANNED" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		PHASE_ACTIVE: {
			on: {
				REFINE_PHASE: { target: "PHASE_ACTIVE" },
				START_STEP: {
					target: "STEP_RUNNING",
					guard: "noConcurrentNonParallelStep",
					action: "suggestCompleteStep",
				},
				COMPLETE_PHASE: {
					target: (ctx: FermentFsmContext) =>
						ctx.phases.every((p) => isPhaseTerminal(p)) ? "COMPLETE" : "PHASE_ACTIVE",
					guard: "phaseActive",
					action: "suggestCompleteFerment",
				},
				SKIP_PHASE: {
					target: (ctx: FermentFsmContext) => {
						if (ctx.phases.every((p) => isPhaseTerminal(p))) return "COMPLETE"
						return "PHASE_ACTIVE"
					},
					guard: "phaseActive",
					action: "suggestActivateNextPhase",
				},
				FAIL_PHASE: {
					target: (ctx: FermentFsmContext) => {
						if (ctx.phases.every((p) => isPhaseTerminal(p))) return "COMPLETE"
						return "PHASE_ACTIVE"
					},
					guard: "phaseActive",
					action: "suggestActivateNextPhase",
				},
				SKIP_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepSkipped",
					action: "suggestNextStepOrCompletePhase",
				},
				FAIL_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepFailed",
					action: "suggestRecovery",
				},
				PAUSE: { target: "PAUSED" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		STEP_RUNNING: {
			on: {
				COMPLETE_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepCompleted",
					action: "suggestNextStepOrCompletePhase",
				},
				VERIFY_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepCompleted",
					action: "suggestNextStepOrCompletePhase",
				},
				SKIP_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepSkipped",
					action: "suggestNextStepOrCompletePhase",
				},
				FAIL_STEP: {
					target: "PHASE_ACTIVE",
					guard: "stepFailed",
					action: "suggestRecovery",
				},
				START_STEP: {
					target: "STEP_RUNNING",
					guard: "noConcurrentNonParallelStep",
					action: "suggestCompleteStep",
				},
				PAUSE: { target: "PAUSED" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		PAUSED: {
			on: {
				RESUME: {
					target: "PHASE_ACTIVE",
					guard: "phaseActive",
					action: "suggestResume",
				},
				RESUME__PLANNED: {
					target: "PHASE_ACTIVE",
					guard: "hasPlannedPhase",
					action: "suggestActivatePhase",
				},
				ABANDON: { target: "ABANDONED" },
			},
		},
		COMPLETE: {
			on: {
				COMPLETE_PHASE: { target: "COMPLETE" },
				SKIP_PHASE: { target: "COMPLETE" },
				FAIL_PHASE: { target: "COMPLETE" },
				COMPLETE_STEP: { target: "COMPLETE" },
				SKIP_STEP: { target: "COMPLETE" },
				FAIL_STEP: { target: "COMPLETE" },
				VERIFY_STEP: { target: "COMPLETE" },
				SET_STEP_GRADE: { target: "COMPLETE" },
				SET_PHASE_GRADE: { target: "COMPLETE" },
				SET_FERMENT_GRADE: { target: "COMPLETE" },
				ABANDON: { target: "ABANDONED" },
			},
		},
		ABANDONED: {
			on: {},
		},
	},
} as const

// ─── Guard Registry ───────────────────────────────────────────────────────────

const GUARDS: Record<string, GuardFn> = {
	hasPhases: (ctx) => (ctx.phases.length > 0 ? null : GUARD_ERRORS.NO_PHASES),

	phaseExistsAndPlanned: (ctx, params) => {
		if (!params.phaseId) return "Missing phaseId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		if (phase.status !== "planned") {
			return `Phase "${phase.id}" is "${phase.status}", expected "planned".`
		}
		return null
	},

	phaseActive: (ctx, params) => {
		if (!params.phaseId) return "Missing phaseId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		if (phase.status !== "active") {
			return GUARD_ERRORS.PHASE_NOT_ACTIVE(phase.id, phase.status)
		}
		return null
	},

	noConcurrentNonParallelStep: (ctx, params) => {
		if (!params.stepId) return "Missing stepId"
		return hasNonParallelRunningStep(ctx, params.stepId)
	},

	stepCompleted: (ctx, params) => {
		if (!params.phaseId || !params.stepId) return "Missing phaseId or stepId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		const step = findStepInPhase(phase, params.stepId)
		if (typeof step === "string") return step
		if (step.status !== "running") {
			return GUARD_ERRORS.STEP_NOT_RUNNING(step.id, step.status)
		}
		return null
	},

	stepSkipped: (ctx, params) => {
		if (!params.phaseId || !params.stepId) return "Missing phaseId or stepId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		const step = findStepInPhase(phase, params.stepId)
		if (typeof step === "string") return step
		if (step.status === "done" || step.status === "verified") {
			return `Step "${step.id}" is already ${step.status}.`
		}
		return null
	},

	stepFailed: (ctx, params) => {
		if (!params.phaseId || !params.stepId) return "Missing phaseId or stepId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		const step = findStepInPhase(phase, params.stepId)
		if (typeof step === "string") return step
		if (step.status !== "running" && step.status !== "pending") {
			return `Step "${step.id}" cannot be failed — status is "${step.status}".`
		}
		return null
	},

	allPhasesTerminal: (ctx) => (areAllPhasesTerminal(ctx) ? null : "Not all phases are terminal."),

	hasNextPlannedPhase: (ctx) => {
		const nextPhase = ctx.phases.find((p) => p.status === "planned")
		if (!nextPhase) return "No more planned phases."
		if (nextPhase.groupIndex !== undefined) {
			const groupPhases = ctx.phases.filter((p) => p.groupIndex === nextPhase.groupIndex)
			const nonTerminal = groupPhases.filter((p) => !isPhaseTerminal(p))
			if (nonTerminal.length > 0) {
				return GUARD_ERRORS.PARALLEL_GROUP_BLOCKED(nonTerminal.map((p) => p.id))
			}
		}
		return null
	},

	hasActiveOrPlannedPhase: (ctx) => {
		// Has an active phase
		if (ctx.activePhaseId) {
			const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
			if (phase && phase.status === "active") {
				return null
			}
		}
		// Or has planned phases
		const planned = ctx.phases.find((p) => p.status === "planned")
		if (planned) {
			return null
		}
		return "No active or planned phases to resume."
	},

	hasPlannedPhase: (ctx) => {
		const planned = ctx.phases.find((p) => p.status === "planned")
		return planned ? null : "No planned phases to resume."
	},

	hasParallelGroupBlocked: (ctx, params) => {
		if (!params.phaseId) return null
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return null
		return checkParallelGroupComplete(ctx, phase)
	},
}

// ─── FSM Implementation ───────────────────────────────────────────────────────

/**
 * Main transition function — given current state, event, and context,
 * returns the new state (or error) and optional suggested action.
 */
export function transition(
	state: FsmState,
	event: AnyEvent,
	ctx: FermentFsmContext,
	params: EventParams = {},
): FsmTransitionResult {
	// Look up transition for current state + event
	const stateTransitions = TRANSITIONS[state]
	if (!stateTransitions) {
		return { state, error: `No transitions defined for state "${state}" with event "${event}".` }
	}

	const transitionEntry = stateTransitions[event]
	if (!transitionEntry) {
		return { state, error: `Event "${event}" is not valid in state "${state}".` }
	}

	// Check guard
	if (transitionEntry.guard) {
		const guardFn = GUARDS[transitionEntry.guard]
		if (guardFn) {
			const guardError = guardFn(ctx, params)
			if (guardError) {
				return { state, error: guardError }
			}
		}
	}

	// Compute target state
	const target = typeof transitionEntry.target === "function" ? transitionEntry.target(ctx) : transitionEntry.target

	// Compute action if present
	let action: FsmAction | undefined
	if (transitionEntry.action) {
		const actionFn = ACTIONS[transitionEntry.action]
		if (actionFn) {
			action = actionFn(ctx, params)
		}
	}

	return { state: target, action }
}

// ─── Actions (suggested next steps) ──────────────────────────────────────────

function buildAction(type: AnyEvent, ctx: FermentFsmContext, params: EventParams, message: string): FsmAction {
	return {
		type,
		phaseId: params.phaseId,
		stepId: params.stepId,
		message,
	}
}

const ACTIONS: Record<string, ActionFn> = {
	suggestRefineOrStartStep: (ctx, params) => {
		const phase = ctx.phases.find((p) => p.id === params.phaseId)
		if (!phase) {
			return buildAction(FSM_EVENTS.ACTIVATE_PHASE, ctx, params, "Phase activated.")
		}
		if (phase.steps.length === 0) {
			return buildAction(
				FSM_EVENTS.REFINE_PHASE,
				ctx,
				params,
				`Phase "${phase.name}" is active. Refine it with steps before starting.`,
			)
		}
		const nextStep = phase.steps.find((s) => s.status === "pending")
		if (nextStep) {
			return buildAction(
				FSM_EVENTS.START_STEP,
				ctx,
				{ ...params, stepId: nextStep.id },
				`Step "${nextStep.description}" is ready to start.`,
			)
		}
		return buildAction(
			FSM_EVENTS.COMPLETE_PHASE,
			ctx,
			params,
			`All steps in "${phase.name}" are terminal. Complete the phase.`,
		)
	},

	suggestCompleteStep: (ctx, params) => {
		const phase = ctx.phases.find((p) => p.id === params.phaseId)
		const step = phase?.steps.find((s) => s.id === params.stepId)
		return buildAction(
			FSM_EVENTS.COMPLETE_STEP,
			ctx,
			params,
			step ? `Step "${step.description}" is running. Complete it when done.` : "Step started.",
		)
	},

	suggestNextStepOrCompletePhase: (ctx, params) => {
		const phase = ctx.phases.find((p) => p.id === params.phaseId)
		if (!phase) {
			return buildAction(FSM_EVENTS.COMPLETE_PHASE, ctx, params, "Phase complete.")
		}
		const nextStep = phase.steps.find((s) => s.status === "pending" || s.status === "failed")
		if (nextStep) {
			const statusNote = nextStep.status === "failed" ? " (retry)" : ""
			return buildAction(
				FSM_EVENTS.START_STEP,
				ctx,
				{ ...params, stepId: nextStep.id },
				`Next step: "${nextStep.description}"${statusNote}`,
			)
		}
		return buildAction(
			FSM_EVENTS.COMPLETE_PHASE,
			ctx,
			params,
			`All steps in "${phase.name}" are terminal. Complete the phase.`,
		)
	},

	suggestRecovery: (ctx, params) => {
		const phase = ctx.phases.find((p) => p.id === params.phaseId)
		const step = phase?.steps.find((s) => s.id === params.stepId)
		return buildAction(
			FSM_EVENTS.START_STEP,
			ctx,
			params,
			step ? `Step "${step.description}" failed. Retry, skip, or revise.` : "Step failed. Take recovery action.",
		)
	},

	suggestCompleteFerment: (_ctx, _params) =>
		buildAction(
			INTERNAL_EVENTS.COMPLETE_FERMENT,
			{} as FermentFsmContext,
			{},
			"All phases complete. Mark ferment as complete.",
		),

	suggestActivateNextPhase: (ctx, params) => {
		const nextPhase = ctx.phases.find((p) => p.status === "planned")
		if (!nextPhase) {
			return buildAction(INTERNAL_EVENTS.COMPLETE_FERMENT, ctx, params, "No more phases.")
		}
		const groupNote = nextPhase.groupIndex !== undefined ? ` (parallel group ${nextPhase.groupIndex})` : ""
		return buildAction(
			FSM_EVENTS.ACTIVATE_PHASE,
			ctx,
			{ ...params, phaseId: nextPhase.id },
			`Activate next phase: "${nextPhase.name}"${groupNote}`,
		)
	},

	suggestResume: (ctx) => {
		const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
		return buildAction(
			FSM_EVENTS.ACTIVATE_PHASE,
			ctx,
			{ phaseId: ctx.activePhaseId },
			phase ? `Resuming phase "${phase.name}".` : "Resuming ferment.",
		)
	},

	suggestActivatePhase: (ctx) => {
		const phase = ctx.phases.find((p) => p.status === "planned")
		if (!phase) {
			return buildAction(FSM_EVENTS.PAUSE, ctx, {}, "No planned phases.")
		}
		return buildAction(FSM_EVENTS.ACTIVATE_PHASE, ctx, { phaseId: phase.id }, `Activate phase: "${phase.name}".`)
	},
}

// ─── Transition Table ─────────────────────────────────────────────────────────

const TRANSITIONS: TransitionMap = {
	[FSM_STATES.IDLE]: {
		[FSM_EVENTS.CREATE_FERMENT]: {
			target: FSM_STATES.DRAFT,
		},
	},

	[FSM_STATES.DRAFT]: {
		[FSM_EVENTS.SCOPE_FERMENT]: {
			target: FSM_STATES.PLANNED,
			guard: "hasPhases",
		},
		[FSM_EVENTS.SET_MODE]: {
			target: FSM_STATES.DRAFT,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.SCOPING]: {
		[FSM_EVENTS.SCOPE_FERMENT]: {
			target: FSM_STATES.PLANNED,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.PLANNED]: {
		[FSM_EVENTS.ACTIVATE_PHASE]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "phaseExistsAndPlanned",
			action: "suggestRefineOrStartStep",
		},
		[FSM_EVENTS.REFINE_PHASE]: {
			target: FSM_STATES.PLANNED,
		},
		[FSM_EVENTS.SKIP_PHASE]: {
			target: FSM_STATES.PLANNED,
			action: "suggestActivateNextPhase",
		},
		[FSM_EVENTS.SCOPE_FERMENT]: {
			target: FSM_STATES.PLANNED,
		},
		[FSM_EVENTS.SET_MODE]: {
			target: FSM_STATES.PLANNED,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.PHASE_ACTIVE]: {
		[FSM_EVENTS.REFINE_PHASE]: {
			target: FSM_STATES.PHASE_ACTIVE,
		},
		[FSM_EVENTS.START_STEP]: {
			target: FSM_STATES.STEP_RUNNING,
			guard: "noConcurrentNonParallelStep",
			action: "suggestCompleteStep",
		},
		[FSM_EVENTS.COMPLETE_PHASE]: {
			target: (ctx) => (areAllPhasesTerminal(ctx) ? FSM_STATES.COMPLETE : FSM_STATES.PHASE_ACTIVE),
			guard: "phaseActive",
			action: "suggestCompleteFerment",
		},
		[FSM_EVENTS.SKIP_PHASE]: {
			target: (ctx) => {
				// After skipping, check if ALL phases would be terminal
				// If this is the only phase or all other phases are already terminal → COMPLETE
				const otherPhases = ctx.phases.filter((p) => p.id !== ctx.activePhaseId)
				const allOtherTerminal = otherPhases.every((p) => isPhaseTerminal(p))
				if (allOtherTerminal) return FSM_STATES.COMPLETE
				return FSM_STATES.PHASE_ACTIVE
			},
			guard: "phaseActive",
			action: "suggestActivateNextPhase",
		},
		[FSM_EVENTS.FAIL_PHASE]: {
			target: (ctx) => {
				// After failing, check if ALL phases would be terminal
				const otherPhases = ctx.phases.filter((p) => p.id !== ctx.activePhaseId)
				const allOtherTerminal = otherPhases.every((p) => isPhaseTerminal(p))
				if (allOtherTerminal) return FSM_STATES.COMPLETE
				return FSM_STATES.PHASE_ACTIVE
			},
			guard: "phaseActive",
			action: "suggestActivateNextPhase",
		},
		[FSM_EVENTS.SKIP_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepSkipped",
			action: "suggestNextStepOrCompletePhase",
		},
		[FSM_EVENTS.FAIL_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepFailed",
			action: "suggestRecovery",
		},
		[FSM_EVENTS.PAUSE]: {
			target: FSM_STATES.PAUSED,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.STEP_RUNNING]: {
		[FSM_EVENTS.COMPLETE_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepCompleted",
			action: "suggestNextStepOrCompletePhase",
		},
		[FSM_EVENTS.VERIFY_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepCompleted",
			action: "suggestNextStepOrCompletePhase",
		},
		[FSM_EVENTS.SKIP_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepSkipped",
			action: "suggestNextStepOrCompletePhase",
		},
		[FSM_EVENTS.FAIL_STEP]: {
			target: FSM_STATES.PHASE_ACTIVE,
			guard: "stepFailed",
			action: "suggestRecovery",
		},
		[FSM_EVENTS.START_STEP]: {
			target: FSM_STATES.STEP_RUNNING,
			guard: "noConcurrentNonParallelStep",
			action: "suggestCompleteStep",
		},
		[FSM_EVENTS.PAUSE]: {
			target: FSM_STATES.PAUSED,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.PAUSED]: {
		[FSM_EVENTS.RESUME]: {
			target: (ctx) => {
				// If there's an active phase, resume it
				if (ctx.activePhaseId) {
					const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
					if (phase && phase.status === "active") {
						return FSM_STATES.PHASE_ACTIVE
					}
				}
				// Otherwise, activate the first planned phase
				const nextPhase = ctx.phases.find((p) => p.status === "planned")
				if (nextPhase) {
					return FSM_STATES.PHASE_ACTIVE
				}
				// No phases to resume, stay paused
				return FSM_STATES.PAUSED
			},
			guard: "hasActiveOrPlannedPhase",
			action: "suggestResume",
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.COMPLETE]: {
		[FSM_EVENTS.COMPLETE_PHASE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.SKIP_PHASE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.FAIL_PHASE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.COMPLETE_STEP]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.SKIP_STEP]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.FAIL_STEP]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.VERIFY_STEP]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.SET_STEP_GRADE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.SET_PHASE_GRADE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.SET_FERMENT_GRADE]: {
			target: FSM_STATES.COMPLETE,
		},
		[FSM_EVENTS.ABANDON]: {
			target: FSM_STATES.ABANDONED,
		},
	},

	[FSM_STATES.ABANDONED]: {},
}

// ─── Map FermentStatus to FsmState ───────────────────────────────────────────

/**
 * Maps the Ferment's status (from types.ts) to the FSM state.
 * This is the authoritative mapping from domain status → FSM state.
 */
export function fermentStatusToFsmState(fermentStatus: FermentStatus): FsmState {
	switch (fermentStatus) {
		case "draft":
			return FSM_STATES.DRAFT
		case "planned":
			return FSM_STATES.PLANNED
		case "running":
			return FSM_STATES.PHASE_ACTIVE
		case "paused":
			return FSM_STATES.PAUSED
		case "complete":
			return FSM_STATES.COMPLETE
		case "abandoned":
			return FSM_STATES.ABANDONED
		default:
			return FSM_STATES.IDLE
	}
}

/**
 * Maps FSM state back to FermentStatus.
 * For states that map to multiple ferment statuses (e.g., PHASE_ACTIVE → running),
 * uses the most common mapping.
 */
export function fsmStateToFermentStatus(fsmState: FsmState): FermentStatus {
	switch (fsmState) {
		case FSM_STATES.IDLE:
			return "draft"
		case FSM_STATES.DRAFT:
		case FSM_STATES.SCOPING:
		case FSM_STATES.PLANNED:
			return "planned"
		case FSM_STATES.PHASE_ACTIVE:
		case FSM_STATES.STEP_RUNNING:
			return "running"
		case FSM_STATES.PAUSED:
			return "paused"
		case FSM_STATES.COMPLETE:
			return "complete"
		case FSM_STATES.ABANDONED:
			return "abandoned"
		default:
			return "draft"
	}
}

// ─── Next Action Computation ──────────────────────────────────────────────────

export type SuggestedAction =
	| { kind: "scope"; message: string }
	| { kind: "refine"; phaseId: string; message: string }
	| { kind: "start_step"; stepId: string; phaseId: string; message: string }
	| { kind: "complete_step"; stepId: string; phaseId: string; message: string }
	| { kind: "complete_phase"; phaseId: string; message: string }
	| { kind: "activate_phase"; phaseId: string; message: string }
	| { kind: "complete_ferment"; message: string }
	| { kind: "paused"; message: string }
	| { kind: "recover_step"; stepId: string; phaseId: string; message: string }
	| { kind: "recover_phase"; phaseId: string; message: string }
	| { kind: "idle"; message: string }

/**
 * Computes the next suggested action based on current FSM state and context.
 * This replaces the logic from engine.ts's `whatNext()` function.
 */
export function nextAction(state: FsmState, ctx: FermentFsmContext): SuggestedAction {
	const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)

	switch (state) {
		case FSM_STATES.IDLE:
		case FSM_STATES.DRAFT:
			return { kind: "scope", message: "Ferment is in draft. Collect goal, criteria, constraints, and phases." }

		case FSM_STATES.SCOPING:
			return { kind: "scope", message: "Continue scoping: collect remaining information from the user." }

		case FSM_STATES.PLANNED: {
			const next = ctx.phases.find((p) => p.status === "planned")
			if (!next) {
				return { kind: "complete_ferment", message: "All phases are terminal. Complete the ferment." }
			}
			const groupNote = next.groupIndex !== undefined ? ` (parallel group ${next.groupIndex})` : ""
			return {
				kind: "activate_phase",
				phaseId: next.id,
				message: `Activate phase "${next.name}"${groupNote} to begin.`,
			}
		}

		case FSM_STATES.PHASE_ACTIVE: {
			if (!phase) {
				return { kind: "paused", message: "No active phase. Something went wrong." }
			}
			if (phase.status === "failed") {
				return {
					kind: "recover_phase",
					phaseId: phase.id,
					message: `Phase "${phase.name}" failed. Retry, skip, or abandon.`,
				}
			}
			if (phase.steps.length === 0) {
				return {
					kind: "refine",
					phaseId: phase.id,
					message: `Phase "${phase.name}" is active but has no steps. Refine it.`,
				}
			}
			const pending = phase.steps.find((s) => s.status === "pending")
			if (pending) {
				return {
					kind: "start_step",
					stepId: pending.id,
					phaseId: phase.id,
					message: `Start step "${pending.description}".`,
				}
			}
			return {
				kind: "complete_phase",
				phaseId: phase.id,
				message: `All steps in "${phase.name}" are terminal. Complete the phase.`,
			}
		}

		case FSM_STATES.STEP_RUNNING: {
			if (!phase) {
				return { kind: "paused", message: "No active phase. Something went wrong." }
			}
			const running = phase.steps.find((s) => s.status === "running")
			if (running) {
				return {
					kind: "complete_step",
					stepId: running.id,
					phaseId: phase.id,
					message: `Step "${running.description}" is running. Complete it when done.`,
				}
			}
			const failed = phase.steps.find((s) => s.status === "failed")
			if (failed) {
				return {
					kind: "recover_step",
					stepId: failed.id,
					phaseId: phase.id,
					message: `Step "${failed.description}" failed. Retry, skip, or revise.`,
				}
			}
			return { kind: "complete_phase", phaseId: phase.id, message: "Step complete. Complete the phase." }
		}

		case FSM_STATES.PAUSED:
			return { kind: "paused", message: "Ferment is paused. Resume or abandon." }

		case FSM_STATES.COMPLETE:
			return { kind: "complete_ferment", message: "Ferment is complete." }

		case FSM_STATES.ABANDONED:
			return { kind: "idle", message: "Ferment is abandoned." }

		default:
			return { kind: "idle", message: "Unknown state." }
	}
}

// ─── Utility: Check if state is terminal ─────────────────────────────────────

export function isTerminalState(state: FsmState): boolean {
	return state === FSM_STATES.COMPLETE || state === FSM_STATES.ABANDONED
}

// ─── Utility: Get valid events for current state ─────────────────────────────

export function getValidEvents(state: FsmState): AnyEvent[] {
	const stateTransitions = TRANSITIONS[state]
	if (!stateTransitions) return []
	return Object.keys(stateTransitions) as AnyEvent[]
}

// Re-export internal events for external use
export { INTERNAL_EVENTS }
