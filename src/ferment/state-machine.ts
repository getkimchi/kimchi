/**
 * Ferment state machine — pure transition logic.
 *
 * Given a current ferment and a command, returns the next ferment or a typed
 * error. No I/O, no LLM calls, no logging — just data in, data out.
 *
 * This is the *transition* state machine: "from state X, command C produces
 * state Y or rejects with reason R". It pairs with engine.ts's *forward*
 * state machine (`whatNext`: "given current state, what should happen
 * next?") to form the full ferment lifecycle.
 *
 * Ownership boundary:
 *   IN STATE MACHINE       OUT OF STATE MACHINE
 *   - status transitions   - file I/O, persistence
 *   - structural rules     - LLM/judge calls
 *   - field updates        - scoping gate (UI flow)
 *   - cross-entity invariants - stuck-loop counter (UI flow)
 *   - id uniqueness        - worktree validation
 *                          - timestamps, randomness
 *
 * The host supplies anything time-or-environment dependent via the `ctx`
 * parameter so transitions remain deterministic and unit-testable.
 */

import { activateSinglePhase, settleAfterPhaseTerminalPatch } from "./lifecycle.js"
import {
	type Decision,
	type Ferment,
	type FermentStatus,
	type JudgeGrade,
	type Memory,
	type MemoryCategory,
	type Phase,
	type PhaseStatus,
	type Step,
	type StepResult,
	type StepStatus,
	inSameParallelCohort,
} from "./types.js"

// ─── Commands ─────────────────────────────────────────────────────────────────

export interface ScopePhaseInput {
	name: string
	goal: string
	description?: string
	constraints?: string[]
	budget?: string
	parallel_group?: number
	steps?: { description: string; verify?: string; parallel_group?: number }[]
}

export interface RefineStepInput {
	description: string
	verify?: string
	parallel_group?: number
}

export type Command =
	| {
			type: "scope"
			title?: string
			goal: string
			successCriteria?: string
			constraints?: string[]
			assumptions?: string
			phases: ScopePhaseInput[]
	  }
	| {
			type: "update_scope_field"
			field: "goal" | "criteria" | "constraints" | "assumptions"
			value: string
	  }
	| { type: "activate_phase"; phaseId: string }
	| { type: "activate_phase_group"; groupIndex: number }
	| { type: "refine_phase"; phaseId: string; steps: RefineStepInput[] }
	| { type: "complete_phase"; phaseId: string; summary: string; grade?: JudgeGrade }
	| { type: "skip_phase"; phaseId: string; reason?: string }
	| { type: "fail_phase"; phaseId: string; reason: string }
	| { type: "start_step"; phaseId: string; stepId: string }
	| {
			type: "complete_step"
			phaseId: string
			stepId: string
			result?: StepResult
			grade?: JudgeGrade
			/** Short worker-written summary of what was accomplished. Persisted on
			 *  the Step so subsequent steps in the same phase can reference it. */
			summary?: string
	  }
	| { type: "verify_step"; phaseId: string; stepId: string; result: StepResult; summary?: string }
	| { type: "skip_step"; phaseId: string; stepId: string }
	| { type: "fail_step"; phaseId: string; stepId: string; error?: string }
	| { type: "update_step_description"; phaseId: string; stepId: string; description: string }
	| { type: "complete_ferment"; finalSummary?: string; grade?: JudgeGrade }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "abandon"; reason?: string }
	| {
			type: "add_decision"
			title: string
			description: string
			phaseId?: string
			stepId?: string
	  }
	| {
			type: "add_memory"
			category: MemoryCategory
			content: string
			phaseId?: string
			stepId?: string
	  }
	| { type: "set_phase_grade"; phaseId: string; grade: JudgeGrade }
	| { type: "set_step_grade"; phaseId: string; stepId: string; grade: JudgeGrade }
	| { type: "set_ferment_grade"; grade: JudgeGrade }
	| { type: "rename"; name: string }

// ─── Errors ───────────────────────────────────────────────────────────────────

export type TransitionError =
	| { code: "FERMENT_NOT_IN_STATUS"; expected: FermentStatus[]; actual: FermentStatus; message: string }
	| { code: "PHASE_NOT_FOUND"; phaseId: string; message: string }
	| { code: "PHASE_NOT_IN_STATUS"; phaseId: string; expected: PhaseStatus[]; actual: PhaseStatus; message: string }
	| { code: "STEP_NOT_FOUND"; stepId: string; message: string }
	| { code: "STEP_NOT_IN_STATUS"; stepId: string; expected: StepStatus[]; actual: StepStatus; message: string }
	| {
			code: "CONCURRENT_NON_PARALLEL_STEP"
			runningStepId: string
			runningStepIndex: number
			runningDescription: string
			message: string
	  }
	| { code: "PHASES_NOT_TERMINAL"; nonTerminalIds: string[]; message: string }
	| { code: "NO_PLANNED_PHASES"; message: string }
	| { code: "INVALID_FIELD"; field: string; message: string }
	| { code: "INVALID_CATEGORY"; category: string; message: string }
	| { code: "PHASE_GROUP_EMPTY"; groupIndex: number; message: string }
	| {
			code: "STEP_RUNNING"
			phaseId: string
			runningStepId: string
			runningStepIndex: number
			runningDescription: string
			message: string
	  }
	| { code: "INVALID_STEP_DESCRIPTION"; message: string }

export interface TransitionContext {
	/** ISO timestamp; injected so transitions are deterministic. */
	now: string
}

export type TransitionResult = { ok: true; ferment: Ferment } | { ok: false; error: TransitionError }

const VALID_MEMORY_CATEGORIES: readonly MemoryCategory[] = [
	"architecture",
	"convention",
	"gotcha",
	"pattern",
	"preference",
]

const TERMINAL_STEP_STATUSES: readonly StepStatus[] = ["done", "verified", "skipped", "failed"]
const TERMINAL_PHASE_STATUSES: readonly PhaseStatus[] = ["completed", "skipped", "failed"]

// ─── Public entry point ───────────────────────────────────────────────────────

export function applyCommand(ferment: Ferment, cmd: Command, ctx: TransitionContext): TransitionResult {
	switch (cmd.type) {
		case "scope":
			return handleScope(ferment, cmd, ctx)
		case "update_scope_field":
			return handleUpdateScopeField(ferment, cmd, ctx)
		case "activate_phase":
			return handleActivatePhase(ferment, cmd, ctx)
		case "activate_phase_group":
			return handleActivatePhaseGroup(ferment, cmd, ctx)
		case "refine_phase":
			return handleRefinePhase(ferment, cmd, ctx)
		case "complete_phase":
			return handleCompletePhase(ferment, cmd, ctx)
		case "skip_phase":
			return handleSkipPhase(ferment, cmd, ctx)
		case "fail_phase":
			return handleFailPhase(ferment, cmd, ctx)
		case "start_step":
			return handleStartStep(ferment, cmd, ctx)
		case "complete_step":
			return handleCompleteStep(ferment, cmd, ctx)
		case "verify_step":
			return handleVerifyStep(ferment, cmd, ctx)
		case "skip_step":
			return handleSkipStep(ferment, cmd, ctx)
		case "fail_step":
			return handleFailStep(ferment, cmd, ctx)
		case "update_step_description":
			return handleUpdateStepDescription(ferment, cmd, ctx)
		case "complete_ferment":
			return handleCompleteFerment(ferment, cmd, ctx)
		case "pause":
			return handlePause(ferment, cmd, ctx)
		case "resume":
			return handleResume(ferment, cmd, ctx)
		case "abandon":
			return handleAbandon(ferment, cmd, ctx)
		case "add_decision":
			return handleAddDecision(ferment, cmd, ctx)
		case "add_memory":
			return handleAddMemory(ferment, cmd, ctx)
		case "set_phase_grade":
			return handleSetPhaseGrade(ferment, cmd, ctx)
		case "set_step_grade":
			return handleSetStepGrade(ferment, cmd, ctx)
		case "set_ferment_grade":
			return handleSetFermentGrade(ferment, cmd, ctx)
		case "rename":
			return handleRename(ferment, cmd, ctx)
	}
}

// ─── Helper: shallow update with timestamp bump ───────────────────────────────

function touch(ferment: Ferment, ctx: TransitionContext, patch: Partial<Ferment> = {}): Ferment {
	return { ...ferment, ...patch, updatedAt: ctx.now }
}

function ok(ferment: Ferment): TransitionResult {
	return { ok: true, ferment }
}

function fail(error: TransitionError): TransitionResult {
	return { ok: false, error }
}

// ─── Status guards ────────────────────────────────────────────────────────────

function requireFermentStatus(ferment: Ferment, expected: FermentStatus[]): TransitionError | null {
	if (expected.includes(ferment.status)) return null
	return {
		code: "FERMENT_NOT_IN_STATUS",
		expected,
		actual: ferment.status,
		message: `Ferment is "${ferment.status}", expected ${expected.map((s) => `"${s}"`).join(" or ")}.`,
	}
}

function findPhase(ferment: Ferment, phaseId: string): { phase: Phase; index: number } | null {
	const index = ferment.phases.findIndex((p) => p.id === phaseId)
	if (index < 0) return null
	return { phase: ferment.phases[index], index }
}

function requirePhase(ferment: Ferment, phaseId: string): { phase: Phase; index: number } | TransitionError {
	const found = findPhase(ferment, phaseId)
	if (!found) {
		return { code: "PHASE_NOT_FOUND", phaseId, message: `Phase "${phaseId}" not found.` }
	}
	return found
}

function requirePhaseStatus(phase: Phase, expected: PhaseStatus[]): TransitionError | null {
	if (expected.includes(phase.status)) return null
	return {
		code: "PHASE_NOT_IN_STATUS",
		phaseId: phase.id,
		expected,
		actual: phase.status,
		message: `Phase "${phase.id}" is "${phase.status}", expected ${expected.map((s) => `"${s}"`).join(" or ")}.`,
	}
}

function findStep(phase: Phase, stepId: string): { step: Step; index: number } | null {
	const index = phase.steps.findIndex((s) => s.id === stepId)
	if (index < 0) return null
	return { step: phase.steps[index], index }
}

function requireStep(phase: Phase, stepId: string): { step: Step; index: number } | TransitionError {
	const found = findStep(phase, stepId)
	if (!found) {
		return { code: "STEP_NOT_FOUND", stepId, message: `Step "${stepId}" not found in phase "${phase.id}".` }
	}
	return found
}

function isTransitionError(v: unknown): v is TransitionError {
	return typeof v === "object" && v !== null && "code" in v && "message" in v
}

// ─── Field updates ────────────────────────────────────────────────────────────

function setPhase(ferment: Ferment, phaseIndex: number, patch: Partial<Phase>): Phase[] {
	return ferment.phases.map((p, i) => (i === phaseIndex ? { ...p, ...patch } : p))
}

function setStep(ferment: Ferment, phaseIndex: number, stepIndex: number, patch: Partial<Step>): Phase[] {
	return ferment.phases.map((p, i) => {
		if (i !== phaseIndex) return p
		return {
			...p,
			steps: p.steps.map((s, j) => (j === stepIndex ? { ...s, ...patch } : s)),
		}
	})
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command handlers
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Cohort resolution ────────────────────────────────────────────────────────
// Singleton parallel_group values collapse to sequential: surfacing a loner as
// parallel mis-signals the engine, events, and UI. Shared by phase and step
// construction since the rule is identical at both layers.

interface CohortFlags {
	parallel: boolean
	groupIndex?: number
}

function resolveCohorts(groups: (number | undefined)[]): CohortFlags[] {
	const counts = new Map<number, number>()
	for (const g of groups) {
		if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1)
	}
	return groups.map((g) => {
		const isMember = g !== undefined && (counts.get(g) ?? 0) >= 2
		return { parallel: isMember, groupIndex: isMember ? g : undefined }
	})
}

interface StepInput {
	description: string
	verify?: string
	parallel_group?: number
}

function buildSteps(inputs: StepInput[]): Step[] {
	const cohorts = resolveCohorts(inputs.map((st) => st.parallel_group))
	return inputs.map((st, i) => ({
		id: `step-${i + 1}`,
		index: i + 1,
		description: st.description,
		status: "pending" as const,
		verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
		...cohorts[i],
	}))
}

// ─── scope ────────────────────────────────────────────────────────────────────
// Saves goal/criteria/constraints/phases and transitions draft → planned.

function handleScope(
	ferment: Ferment,
	cmd: Extract<Command, { type: "scope" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["draft"])
	if (guard) return fail(guard)

	const phaseCohorts = resolveCohorts(cmd.phases.map((p) => p.parallel_group))

	const phases: Phase[] = cmd.phases.map((p, i) => {
		const steps: Step[] = buildSteps(
			(p.steps ?? []).map((st) => ({
				description: st.description,
				verify: st.verify,
				parallel_group: st.parallel_group,
			})),
		)
		return {
			id: `phase-${i + 1}`,
			index: i + 1,
			name: p.name,
			goal: p.goal,
			description: p.description ?? "",
			constraints: p.constraints,
			budget: p.budget,
			...phaseCohorts[i],
			status: "planned" as const,
			steps,
		}
	})

	const scoping = { ...ferment.scoping }
	scoping.goal = { answer: cmd.goal, confirmedAt: ctx.now }
	if (cmd.successCriteria) scoping.criteria = { answer: cmd.successCriteria, confirmedAt: ctx.now }
	if (cmd.constraints && cmd.constraints.length > 0) {
		scoping.constraints = { answer: cmd.constraints.join(", "), confirmedAt: ctx.now }
	}
	if (cmd.assumptions && cmd.assumptions.trim().length > 0) {
		scoping.assumptions = { answer: cmd.assumptions, confirmedAt: ctx.now }
	}
	if (phases.length > 0) {
		scoping.phases = { answer: phases.map((p) => p.name).join(", "), confirmedAt: ctx.now }
	}

	return ok(
		touch(ferment, ctx, {
			name: cmd.title ?? ferment.name,
			goal: cmd.goal,
			successCriteria: cmd.successCriteria,
			constraints: cmd.constraints,
			scoping,
			phases,
			status: "planned",
		}),
	)
}

// ─── update_scope_field ───────────────────────────────────────────────────────

function handleUpdateScopeField(
	ferment: Ferment,
	cmd: Extract<Command, { type: "update_scope_field" }>,
	ctx: TransitionContext,
): TransitionResult {
	const scoping = { ...ferment.scoping }
	const patch: Partial<Ferment> = {}

	if (cmd.field === "goal") {
		patch.goal = cmd.value
		scoping.goal = { answer: cmd.value, confirmedAt: ctx.now }
	} else if (cmd.field === "criteria") {
		patch.successCriteria = cmd.value
		scoping.criteria = { answer: cmd.value, confirmedAt: ctx.now }
	} else if (cmd.field === "constraints") {
		const parsed = cmd.value
			.split(",")
			.map((c) => c.trim())
			.filter(Boolean)
		patch.constraints = parsed
		scoping.constraints = { answer: parsed.join(", "), confirmedAt: ctx.now }
	} else if (cmd.field === "assumptions") {
		scoping.assumptions = { answer: cmd.value, confirmedAt: ctx.now }
	} else {
		return fail({
			code: "INVALID_FIELD",
			field: cmd.field,
			message: `Unknown field: "${cmd.field}". Use goal, criteria, constraints, or assumptions.`,
		})
	}

	return ok(touch(ferment, ctx, { ...patch, scoping }))
}

// ─── rename ───────────────────────────────────────────────────────────────────

function handleRename(
	ferment: Ferment,
	cmd: Extract<Command, { type: "rename" }>,
	ctx: TransitionContext,
): TransitionResult {
	return ok(touch(ferment, ctx, { name: cmd.name }))
}

// ─── activate_phase ───────────────────────────────────────────────────────────

function handleActivatePhase(
	ferment: Ferment,
	cmd: Extract<Command, { type: "activate_phase" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { phase, index } = found

	const guard = requirePhaseStatus(phase, ["planned", "failed"])
	if (guard) return fail(guard)

	// Deactivate any other active phase, then activate this one.
	const phases = activateSinglePhase(ferment.phases, phase.id, ctx.now)

	return ok(
		touch(ferment, ctx, {
			phases,
			activePhaseId: phase.id,
			lastActiveAt: ctx.now,
			status: "running",
		}),
	)
}

// ─── activate_phase_group ─────────────────────────────────────────────────────

function handleActivatePhaseGroup(
	ferment: Ferment,
	cmd: Extract<Command, { type: "activate_phase_group" }>,
	ctx: TransitionContext,
): TransitionResult {
	const groupPhases = ferment.phases.filter((p) => p.groupIndex === cmd.groupIndex && p.status === "planned")
	if (groupPhases.length === 0) {
		return fail({
			code: "PHASE_GROUP_EMPTY",
			groupIndex: cmd.groupIndex,
			message: `No planned phases in group ${cmd.groupIndex}.`,
		})
	}

	// Audit doc finding #1: deactivate any phase that's currently active and
	// NOT in the target group. Without this sweep, a previously-active
	// non-group phase stays active alongside the new group, breaking the
	// "active phases are exactly the target group" invariant.
	const phases = ferment.phases.map((p) => {
		if (p.groupIndex === cmd.groupIndex && p.status === "planned") {
			return { ...p, status: "active" as const, startedAt: ctx.now }
		}
		if (p.status === "active" && p.groupIndex !== cmd.groupIndex) {
			return { ...p, status: "planned" as const }
		}
		return p
	})

	return ok(
		touch(ferment, ctx, {
			phases,
			activePhaseId: groupPhases[0].id,
			lastActiveAt: ctx.now,
			status: "running",
		}),
	)
}

// ─── refine_phase ─────────────────────────────────────────────────────────────

function handleRefinePhase(
	ferment: Ferment,
	cmd: Extract<Command, { type: "refine_phase" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { phase, index } = found

	const guard = requirePhaseStatus(phase, ["active"])
	if (guard) return fail(guard)

	// Audit doc finding #4: refine_phase rebuilds the entire steps array, so
	// allowing it through while a step is `running` would silently delete the
	// in-flight step. The subagent's later `complete_step` would hit
	// STEP_NOT_FOUND and the work product would be lost. Reject up front.
	const running = phase.steps.find((s) => s.status === "running")
	if (running) {
		return fail({
			code: "STEP_RUNNING",
			phaseId: phase.id,
			runningStepId: running.id,
			runningStepIndex: running.index,
			runningDescription: running.description,
			message: `Cannot refine phase ${phase.index} "${phase.name}" — step ${running.index} ("${running.description}") is currently running. Complete, skip, or fail it before refining.`,
		})
	}

	const steps: Step[] = buildSteps(cmd.steps)

	return ok(touch(ferment, ctx, { phases: setPhase(ferment, index, { steps }) }))
}

// ─── start_step ───────────────────────────────────────────────────────────────

function handleStartStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "start_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { step, index: stepIndex } = stepFound

	const alreadyRunning = phase.steps.find((s) => s.status === "running" && s.id !== step.id)
	if (alreadyRunning && !inSameParallelCohort(alreadyRunning, step)) {
		return fail({
			code: "CONCURRENT_NON_PARALLEL_STEP",
			runningStepId: alreadyRunning.id,
			runningStepIndex: alreadyRunning.index,
			runningDescription: alreadyRunning.description,
			message: `Cannot start step ${step.index} — step ${alreadyRunning.index} ("${alreadyRunning.description}") is already running and is not in the same parallel group.`,
		})
	}

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, { status: "running", startedAt: ctx.now }),
		}),
	)
}

// ─── complete_step ────────────────────────────────────────────────────────────

function handleCompleteStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	// Verify result determines status: verified vs done.
	const status: StepStatus = cmd.result?.success ? "verified" : "done"

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, {
				status,
				completedAt: ctx.now,
				result: cmd.result,
				grade: cmd.grade,
				summary: cmd.summary,
			}),
		}),
	)
}

// ─── verify_step ──────────────────────────────────────────────────────────────

function handleVerifyStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "verify_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const status: StepStatus = cmd.result.success ? "verified" : "done"

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, {
				status,
				// Use server-side ctx.now rather than the user-supplied result.completedAt
				// so a misbehaving worker can't backdate or postdate completion.
				completedAt: ctx.now,
				result: { ...cmd.result, completedAt: ctx.now },
				summary: cmd.summary,
			}),
		}),
	)
}

// ─── skip_step ────────────────────────────────────────────────────────────────

function handleSkipStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "skip_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, { status: "skipped", completedAt: ctx.now }),
		}),
	)
}

// ─── fail_step ────────────────────────────────────────────────────────────────

function handleFailStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "fail_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const result: StepResult | undefined = cmd.error
		? { success: false, stderr: cmd.error, completedAt: ctx.now }
		: undefined

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, {
				status: "failed",
				completedAt: ctx.now,
				result,
			}),
		}),
	)
}

// ─── update_step_description ──────────────────────────────────────────────────

function handleUpdateStepDescription(
	ferment: Ferment,
	cmd: Extract<Command, { type: "update_step_description" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const trimmed = cmd.description.trim()
	if (!trimmed) {
		return fail({
			code: "INVALID_STEP_DESCRIPTION",
			message: "Step description must not be empty.",
		})
	}

	return ok(
		touch(ferment, ctx, {
			phases: setStep(ferment, phaseIndex, stepIndex, { description: trimmed }),
		}),
	)
}

// ─── complete_phase ───────────────────────────────────────────────────────────

function handleCompletePhase(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_phase" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { phase, index } = found

	// Phase must be active to complete.
	const guard = requirePhaseStatus(phase, ["active"])
	if (guard) return fail(guard)

	const phases = setPhase(ferment, index, {
		status: "completed",
		summary: cmd.summary,
		completedAt: ctx.now,
		grade: cmd.grade,
	})

	return ok(touch(ferment, ctx, settleAfterPhaseTerminalPatch(phases)))
}

// ─── skip_phase ───────────────────────────────────────────────────────────────

function handleSkipPhase(
	ferment: Ferment,
	cmd: Extract<Command, { type: "skip_phase" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	const phases = setPhase(ferment, index, {
		status: "skipped",
		summary: cmd.reason ?? "Skipped",
		completedAt: ctx.now,
	})

	return ok(touch(ferment, ctx, settleAfterPhaseTerminalPatch(phases)))
}

// ─── fail_phase ───────────────────────────────────────────────────────────────

function handleFailPhase(
	ferment: Ferment,
	cmd: Extract<Command, { type: "fail_phase" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	const phases = setPhase(ferment, index, {
		status: "failed",
		summary: cmd.reason,
		completedAt: ctx.now,
	})

	return ok(touch(ferment, ctx, settleAfterPhaseTerminalPatch(phases)))
}

// ─── complete_ferment ─────────────────────────────────────────────────────────

function handleCompleteFerment(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_ferment" }>,
	ctx: TransitionContext,
): TransitionResult {
	if (ferment.status === "complete") {
		return fail({
			code: "FERMENT_NOT_IN_STATUS",
			expected: ["planned", "running"],
			actual: ferment.status,
			message: `Ferment "${ferment.name}" is already complete.`,
		})
	}
	if (ferment.status === "abandoned") {
		return fail({
			code: "FERMENT_NOT_IN_STATUS",
			expected: ["planned", "running"],
			actual: ferment.status,
			message: `Ferment "${ferment.name}" is abandoned and cannot be completed.`,
		})
	}

	const nonTerminal = ferment.phases.filter((p) => !TERMINAL_PHASE_STATUSES.includes(p.status))
	if (nonTerminal.length > 0) {
		return fail({
			code: "PHASES_NOT_TERMINAL",
			nonTerminalIds: nonTerminal.map((p) => p.id),
			message: `Cannot complete: ${nonTerminal.length} phase(s) still active or planned: ${nonTerminal.map((p) => `"${p.name}"`).join(", ")}`,
		})
	}

	const patch: Partial<Ferment> = { status: "complete" }
	if (cmd.grade) patch.grade = cmd.grade
	// finalSummary intentionally not stored on Ferment — host can append it
	// to a custom field via metadata if needed. Today it just goes into the
	// tool result text.
	return ok(touch(ferment, ctx, patch))
}

// ─── pause / resume ───────────────────────────────────────────────────────────
// Pause flips a running/planned ferment to "paused". Once paused, the bridge
// (applyAndPersist) refuses every other state-machine command except `resume`
// and `abandon`, so the planner is structurally prevented from continuing
// regardless of what's in its conversation context.

function handlePause(
	ferment: Ferment,
	_cmd: Extract<Command, { type: "pause" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["running", "planned"])
	if (guard) return fail(guard)

	// Reset any running steps to pending since their subagent will be killed.
	// Without this, determineNextAction later suggests complete_step for a
	// step whose subagent is already dead.
	const phases = ferment.phases.map((p) => ({
		...p,
		steps: p.steps.map((s) => (s.status === "running" ? { ...s, status: "pending" as const } : s)),
	}))

	return ok(touch(ferment, ctx, { status: "paused", phases }))
}

function handleResume(
	ferment: Ferment,
	_cmd: Extract<Command, { type: "resume" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["paused"])
	if (guard) return fail(guard)
	const activePhase = ferment.phases.find((p) => p.status === "active")
	return ok(
		touch(ferment, ctx, {
			status: activePhase ? "running" : "planned",
			activePhaseId: activePhase?.id,
		}),
	)
}

// ─── abandon ──────────────────────────────────────────────────────────────────

function handleAbandon(
	ferment: Ferment,
	cmd: Extract<Command, { type: "abandon" }>,
	ctx: TransitionContext,
): TransitionResult {
	const description = cmd.reason
		? `${ferment.description ?? ""}\n\nAbandoned: ${cmd.reason}`.trim()
		: ferment.description
	return ok(touch(ferment, ctx, { status: "abandoned", description }))
}

// ─── add_decision ─────────────────────────────────────────────────────────────

function handleAddDecision(
	ferment: Ferment,
	cmd: Extract<Command, { type: "add_decision" }>,
	ctx: TransitionContext,
): TransitionResult {
	const maxIdx = ferment.decisions.reduce((m, d) => {
		const n = Number.parseInt(d.id.slice(1), 10)
		return Number.isFinite(n) && n > m ? n : m
	}, 0)
	const decision: Decision = {
		id: `D${String(maxIdx + 1).padStart(3, "0")}`,
		title: cmd.title,
		description: cmd.description,
		phaseId: cmd.phaseId,
		stepId: cmd.stepId,
		createdAt: ctx.now,
	}
	return ok(touch(ferment, ctx, { decisions: [...ferment.decisions, decision] }))
}

// ─── add_memory ───────────────────────────────────────────────────────────────

function handleAddMemory(
	ferment: Ferment,
	cmd: Extract<Command, { type: "add_memory" }>,
	ctx: TransitionContext,
): TransitionResult {
	if (!VALID_MEMORY_CATEGORIES.includes(cmd.category)) {
		return fail({
			code: "INVALID_CATEGORY",
			category: cmd.category,
			message: `Invalid category "${cmd.category}". Use one of: ${VALID_MEMORY_CATEGORIES.join(", ")}.`,
		})
	}
	const maxIdx = ferment.memories.reduce((m, mem) => {
		const n = Number.parseInt(mem.id.slice(1), 10)
		return Number.isFinite(n) && n > m ? n : m
	}, 0)
	const memory: Memory = {
		id: `M${String(maxIdx + 1).padStart(3, "0")}`,
		category: cmd.category,
		content: cmd.content,
		phaseId: cmd.phaseId,
		stepId: cmd.stepId,
		createdAt: ctx.now,
	}
	return ok(touch(ferment, ctx, { memories: [...ferment.memories, memory] }))
}

// ─── set_phase_grade ──────────────────────────────────────────────────────────

function handleSetPhaseGrade(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_phase_grade" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	return ok(touch(ferment, ctx, { phases: setPhase(ferment, index, { grade: cmd.grade }) }))
}

// ─── set_step_grade ───────────────────────────────────────────────────────────

function handleSetStepGrade(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_step_grade" }>,
	ctx: TransitionContext,
): TransitionResult {
	const phaseFound = requirePhase(ferment, cmd.phaseId)
	if (isTransitionError(phaseFound)) return fail(phaseFound)
	const { phase, index: phaseIndex } = phaseFound

	const stepFound = requireStep(phase, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	return ok(touch(ferment, ctx, { phases: setStep(ferment, phaseIndex, stepIndex, { grade: cmd.grade }) }))
}

// ─── set_ferment_grade ────────────────────────────────────────────────────────

function handleSetFermentGrade(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_ferment_grade" }>,
	ctx: TransitionContext,
): TransitionResult {
	return ok(touch(ferment, ctx, { grade: cmd.grade }))
}

// ─── Re-exports for callers that need the constants ──────────────────────────

export { TERMINAL_PHASE_STATUSES, TERMINAL_STEP_STATUSES, VALID_MEMORY_CATEGORIES }
