/**
 * Ferment Finite State Machine — pure transitions + guards.
 *
 * The FSM is a *validator*: given a current state, an event, and an
 * FsmContext, it answers "is this transition legal?" and "what's the new
 * state?". It does NOT compute a "what next?" suggestion — that lives in
 * `engine.determineNextAction`, which the planner system prompt and the
 * resume nudges actually consume.
 *
 * Earlier versions of this file shipped:
 *   1. `fsmConfig` — a parallel XState-style declaration of the same
 *      transitions, never consumed by anything;
 *   2. `nextAction` / `SuggestedAction` — a second "what's next?" computer
 *      that the engine never called;
 *   3. an action-suggestion machinery (`ACTIONS`, `buildAction`, `FsmAction`,
 *      `INTERNAL_EVENTS`) attached to every transition, returned in
 *      `FsmTransitionResult.action`, also never consumed.
 *
 * All three were dead. They've been deleted to make the contract explicit:
 * this module guards transitions, the engine decides next steps. See §4.1
 * of docs/ferment-review.md for the full audit trail.
 *
 * States:
 *   IDLE → DRAFT → PLANNED → PHASE_ACTIVE → STEP_RUNNING → COMPLETE
 *                ↘         ↘             ↘
 *                ABANDONED  PAUSED       PAUSED
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
}

// ─── Event Parameters ─────────────────────────────────────────────────────────

export interface EventParams {
	phaseId?: string
	stepId?: string
	mode?: string
}

// ─── Guard helpers ────────────────────────────────────────────────────────────

type GuardFn = (ctx: FermentFsmContext, params: EventParams) => string | null

const GUARD_ERRORS = {
	PHASE_NOT_FOUND: (id: string) => `Phase "${id}" not found.`,
	PHASE_NOT_ACTIVE: (id: string, status: PhaseStatus) => `Phase "${id}" is "${status}", expected "active".`,
	STEP_NOT_FOUND: (id: string, phaseId: string) => `Step "${id}" not found in phase "${phaseId}".`,
	STEP_NOT_RUNNING: (id: string, status: StepStatus) => `Step "${id}" is "${status}", expected "running".`,
	CONCURRENT_STEP: (runningId: string) =>
		`Cannot start new step — step "${runningId}" is already running (non-parallel).`,
} as const

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
	if (!ctx.activePhaseId) return null
	const activePhase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
	if (!activePhase) return null

	const runningStep = activePhase.steps.find((s) => s.status === "running" && s.id !== newStepId)
	if (!runningStep) return null

	const newStep = activePhase.steps.find((s) => s.id === newStepId)
	if (runningStep.canRunParallel && newStep?.canRunParallel) return null

	return GUARD_ERRORS.CONCURRENT_STEP(runningStep.id)
}

function phaseTerminalTarget(ctx: FermentFsmContext, params: EventParams): FsmState {
	const terminalPhaseId = params.phaseId
	// applyCommand keeps non-parallel phases mutually exclusive; any other active
	// phase here represents a parallel sibling that should keep the ferment running.
	const anotherActivePhase = ctx.phases.find((p) => p.status === "active" && p.id !== terminalPhaseId)
	return anotherActivePhase ? FSM_STATES.PHASE_ACTIVE : FSM_STATES.PLANNED
}

// ─── Guard registry ───────────────────────────────────────────────────────────
//
// The SCOPE_FERMENT event used to carry a `hasPhases` guard; that was wrong —
// `scope` is what *creates* phases, so the guard rejected every legitimate
// scope-from-draft call. Tool-layer code (lifecycle.ts) papered over this by
// skipping FSM validation when status was "draft". Removing the guard lets the
// state-machine owner handle scope-from-draft correctly without the workaround.

const GUARDS: Record<string, GuardFn> = {
	phaseExistsAndPlanned: (ctx, params) => {
		if (!params.phaseId) return "Missing phaseId"
		const phase = findPhaseById(ctx, params.phaseId)
		if (typeof phase === "string") return phase
		if (phase.status !== "planned" && phase.status !== "failed") {
			return `Phase "${phase.id}" is "${phase.status}", expected "planned" or "failed".`
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

	hasActiveOrPlannedPhase: (ctx) => {
		if (ctx.activePhaseId) {
			const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
			if (phase && phase.status === "active") return null
		}
		const planned = ctx.phases.find((p) => p.status === "planned")
		if (planned) return null
		return "No active or planned phases to resume."
	},
}

// ─── Transition Entry ─────────────────────────────────────────────────────────

interface TransitionEntry {
	target: FsmState | ((ctx: FermentFsmContext, params: EventParams) => FsmState)
	guard?: string
}

type TransitionMap = Partial<Record<FsmState, Partial<Record<string, TransitionEntry>>>>

// ─── Transition Table ─────────────────────────────────────────────────────────

const TRANSITIONS: TransitionMap = {
	[FSM_STATES.IDLE]: {
		[FSM_EVENTS.CREATE_FERMENT]: { target: FSM_STATES.DRAFT },
	},

	[FSM_STATES.DRAFT]: {
		// scope creates phases; no `hasPhases` precondition. Tool-layer no longer
		// needs to skip FSM validation when status === "draft" (the previous
		// duct-tape workaround in lifecycle.ts is gone).
		[FSM_EVENTS.SCOPE_FERMENT]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.SET_MODE]: { target: FSM_STATES.DRAFT },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.SCOPING]: {
		[FSM_EVENTS.SCOPE_FERMENT]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.PLANNED]: {
		[FSM_EVENTS.ACTIVATE_PHASE]: { target: FSM_STATES.PHASE_ACTIVE, guard: "phaseExistsAndPlanned" },
		[FSM_EVENTS.REFINE_PHASE]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.SKIP_PHASE]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.SCOPE_FERMENT]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.SET_MODE]: { target: FSM_STATES.PLANNED },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.PHASE_ACTIVE]: {
		[FSM_EVENTS.REFINE_PHASE]: { target: FSM_STATES.PHASE_ACTIVE },
		[FSM_EVENTS.START_STEP]: { target: FSM_STATES.STEP_RUNNING, guard: "noConcurrentNonParallelStep" },
		[FSM_EVENTS.COMPLETE_PHASE]: {
			target: phaseTerminalTarget,
			guard: "phaseActive",
		},
		[FSM_EVENTS.SKIP_PHASE]: {
			target: phaseTerminalTarget,
			guard: "phaseActive",
		},
		[FSM_EVENTS.FAIL_PHASE]: {
			target: phaseTerminalTarget,
			guard: "phaseActive",
		},
		[FSM_EVENTS.SKIP_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepSkipped" },
		[FSM_EVENTS.FAIL_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepFailed" },
		[FSM_EVENTS.PAUSE]: { target: FSM_STATES.PAUSED },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.STEP_RUNNING]: {
		[FSM_EVENTS.COMPLETE_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepCompleted" },
		[FSM_EVENTS.VERIFY_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepCompleted" },
		[FSM_EVENTS.SKIP_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepSkipped" },
		[FSM_EVENTS.FAIL_STEP]: { target: FSM_STATES.PHASE_ACTIVE, guard: "stepFailed" },
		[FSM_EVENTS.START_STEP]: { target: FSM_STATES.STEP_RUNNING, guard: "noConcurrentNonParallelStep" },
		[FSM_EVENTS.PAUSE]: { target: FSM_STATES.PAUSED },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.PAUSED]: {
		[FSM_EVENTS.RESUME]: {
			target: (ctx) => {
				if (ctx.activePhaseId) {
					const phase = ctx.phases.find((p) => p.id === ctx.activePhaseId)
					if (phase && phase.status === "active") return FSM_STATES.PHASE_ACTIVE
				}
				return FSM_STATES.PLANNED
			},
		},
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.COMPLETE]: {
		[FSM_EVENTS.COMPLETE_PHASE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.SKIP_PHASE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.FAIL_PHASE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.COMPLETE_STEP]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.SKIP_STEP]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.FAIL_STEP]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.VERIFY_STEP]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.SET_STEP_GRADE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.SET_PHASE_GRADE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.SET_FERMENT_GRADE]: { target: FSM_STATES.COMPLETE },
		[FSM_EVENTS.ABANDON]: { target: FSM_STATES.ABANDONED },
	},

	[FSM_STATES.ABANDONED]: {},
}

// ─── Transition function ──────────────────────────────────────────────────────

/**
 * Recovery hints for the most common "wrong event in this state" mistakes.
 * Returned alongside the base "not valid in state" message so the agent has
 * something actionable instead of having to guess at the next call.
 *
 * Key is `${state}:${event}`. Hints describe what the agent should do
 * *instead* — not why the rejection happened.
 */
const RECOVERY_HINTS: Partial<Record<string, string>> = {
	[`${FSM_STATES.PHASE_ACTIVE}:${FSM_EVENTS.ACTIVATE_PHASE}`]:
		"A phase is already active. Call start_step to begin its work, or complete_phase / skip_phase / fail_phase to finish it before activating another.",
	[`${FSM_STATES.STEP_RUNNING}:${FSM_EVENTS.ACTIVATE_PHASE}`]:
		"A step is currently running in the active phase. Call complete_step / skip_step / fail_step first, then complete_phase, then activate the next phase.",
	[`${FSM_STATES.PHASE_ACTIVE}:${FSM_EVENTS.COMPLETE_STEP}`]:
		"No step is currently running. Call start_step to begin a step before completing it.",
	[`${FSM_STATES.PHASE_ACTIVE}:${FSM_EVENTS.VERIFY_STEP}`]:
		"No step is currently running. Call start_step to begin a step before verifying it.",
	[`${FSM_STATES.PHASE_ACTIVE}:${FSM_EVENTS.SET_MODE}`]:
		"set_mode is only valid before a phase is active. Pause the ferment first if you need to change mode.",
	[`${FSM_STATES.STEP_RUNNING}:${FSM_EVENTS.SET_MODE}`]:
		"set_mode is only valid before a phase is active. Pause the ferment first if you need to change mode.",
	[`${FSM_STATES.STEP_RUNNING}:${FSM_EVENTS.COMPLETE_PHASE}`]:
		"A step is still running in this phase. Finish or fail the running step before completing the phase.",
	[`${FSM_STATES.PLANNED}:${FSM_EVENTS.START_STEP}`]: "No phase is active. Call activate_phase first, then start_step.",
	[`${FSM_STATES.PLANNED}:${FSM_EVENTS.COMPLETE_STEP}`]:
		"No phase is active. Call activate_phase then start_step before completing a step.",
	[`${FSM_STATES.PLANNED}:${FSM_EVENTS.COMPLETE_PHASE}`]: "No phase is active. Call activate_phase first.",
	[`${FSM_STATES.COMPLETE}:${FSM_EVENTS.ACTIVATE_PHASE}`]:
		"This ferment is complete. Start a new ferment to do more work.",
}

function describeValidEvents(state: FsmState): string {
	const stateTransitions = TRANSITIONS[state]
	if (!stateTransitions) return ""
	const valid = Object.keys(stateTransitions)
	if (valid.length === 0) return ""
	return `Valid events in state "${state}": ${valid.join(", ")}.`
}

/**
 * Validate a transition. Returns the new state (or the current state with an
 * `error` if the transition was rejected). Pure — no I/O, no side effects.
 */
export function transition(
	state: FsmState,
	event: FsmEvent,
	ctx: FermentFsmContext,
	params: EventParams = {},
): FsmTransitionResult {
	const stateTransitions = TRANSITIONS[state]
	if (!stateTransitions) {
		return { state, error: `No transitions defined for state "${state}" with event "${event}".` }
	}

	const transitionEntry = stateTransitions[event]
	if (!transitionEntry) {
		const base = `Event "${event}" is not valid in state "${state}".`
		const hint = RECOVERY_HINTS[`${state}:${event}`]
		const fallback = hint ? "" : ` ${describeValidEvents(state)}`
		const tail = hint ? ` ${hint}` : fallback
		return { state, error: `${base}${tail}` }
	}

	if (transitionEntry.guard) {
		const guardFn = GUARDS[transitionEntry.guard]
		if (guardFn) {
			const guardError = guardFn(ctx, params)
			if (guardError) return { state, error: guardError }
		}
	}

	const target =
		typeof transitionEntry.target === "function" ? transitionEntry.target(ctx, params) : transitionEntry.target
	return { state: target }
}

// ─── Status mapping ───────────────────────────────────────────────────────────

/** Maps a Ferment's domain status to its FSM state. */
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

/** Maps an FSM state back to a Ferment domain status. */
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

// ─── Utility helpers ──────────────────────────────────────────────────────────

export function isTerminalState(state: FsmState): boolean {
	return state === FSM_STATES.COMPLETE || state === FSM_STATES.ABANDONED
}

export function getValidEvents(state: FsmState): FsmEvent[] {
	const stateTransitions = TRANSITIONS[state]
	if (!stateTransitions) return []
	return Object.keys(stateTransitions) as FsmEvent[]
}
