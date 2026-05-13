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

import { activateSingleStage, settleAfterStageTerminalPatch } from "./lifecycle.js"
import type {
	Decision,
	Ferment,
	FermentStatus,
	FermentWorkMode,
	JudgeGrade,
	Memory,
	MemoryCategory,
	Stage,
	StageStatus,
	Step,
	StepResult,
	StepStatus,
} from "./types.js"

// ─── Commands ─────────────────────────────────────────────────────────────────

export interface ScopePhaseInput {
	name: string
	goal: string
	description?: string
	constraints?: string[]
	budget?: string
	parallel_group?: number
	steps?: { description: string; verify?: string }[]
}

export interface RefineStepInput {
	description: string
	verify?: string
	needs_vision?: boolean
	can_run_parallel?: boolean
}

export type Command =
	| {
			type: "scope"
			title?: string
			goal: string
			successCriteria?: string
			constraints?: string[]
			phases: ScopePhaseInput[]
	  }
	| {
			type: "update_scope_field"
			field: "goal" | "criteria" | "constraints"
			value: string
	  }
	| { type: "set_mode"; mode: FermentWorkMode }
	| { type: "activate_stage"; stageId: string }
	| { type: "activate_phase_group"; groupIndex: number }
	| { type: "refine_stage"; stageId: string; steps: RefineStepInput[] }
	| { type: "complete_stage"; stageId: string; summary: string; grade?: JudgeGrade }
	| { type: "skip_stage"; stageId: string; reason?: string }
	| { type: "fail_stage"; stageId: string; reason: string }
	| { type: "start_step"; stageId: string; stepId: string }
	| {
			type: "complete_step"
			stageId: string
			stepId: string
			result?: StepResult
			grade?: JudgeGrade
			/** Short worker-written summary of what was accomplished. Persisted on
			 *  the Step so subsequent steps in the same stage can reference it. */
			summary?: string
	  }
	| { type: "verify_step"; stageId: string; stepId: string; result: StepResult; summary?: string }
	| { type: "skip_step"; stageId: string; stepId: string }
	| { type: "fail_step"; stageId: string; stepId: string; error?: string }
	| { type: "complete_ferment"; finalSummary?: string; grade?: JudgeGrade }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "abandon"; reason?: string }
	| {
			type: "add_decision"
			title: string
			description: string
			stageId?: string
			stepId?: string
	  }
	| {
			type: "add_memory"
			category: MemoryCategory
			content: string
			stageId?: string
			stepId?: string
	  }
	| { type: "set_stage_grade"; stageId: string; grade: JudgeGrade }
	| { type: "set_step_grade"; stageId: string; stepId: string; grade: JudgeGrade }
	| { type: "set_ferment_grade"; grade: JudgeGrade }
	| { type: "rename"; name: string }

// ─── Errors ───────────────────────────────────────────────────────────────────

export type TransitionError =
	| { code: "FERMENT_NOT_IN_STATUS"; expected: FermentStatus[]; actual: FermentStatus; message: string }
	| { code: "PHASE_NOT_FOUND"; stageId: string; message: string }
	| { code: "PHASE_NOT_IN_STATUS"; stageId: string; expected: StageStatus[]; actual: StageStatus; message: string }
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
	| { code: "INVALID_MODE"; mode: string; message: string }
	| { code: "INVALID_FIELD"; field: string; message: string }
	| { code: "INVALID_CATEGORY"; category: string; message: string }
	| { code: "PHASE_GROUP_EMPTY"; groupIndex: number; message: string }
	| {
			code: "STEP_RUNNING"
			stageId: string
			runningStepId: string
			runningStepIndex: number
			runningDescription: string
			message: string
	  }

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
const TERMINAL_STAGE_STATUSES: readonly StageStatus[] = ["completed", "skipped", "failed"]

// ─── Public entry point ───────────────────────────────────────────────────────

export function applyCommand(ferment: Ferment, cmd: Command, ctx: TransitionContext): TransitionResult {
	switch (cmd.type) {
		case "scope":
			return handleScope(ferment, cmd, ctx)
		case "update_scope_field":
			return handleUpdateScopeField(ferment, cmd, ctx)
		case "set_mode":
			return handleSetMode(ferment, cmd, ctx)
		case "activate_stage":
			return handleActivateStage(ferment, cmd, ctx)
		case "activate_phase_group":
			return handleActivatePhaseGroup(ferment, cmd, ctx)
		case "refine_stage":
			return handleRefineStage(ferment, cmd, ctx)
		case "complete_stage":
			return handleCompleteStage(ferment, cmd, ctx)
		case "skip_stage":
			return handleSkipStage(ferment, cmd, ctx)
		case "fail_stage":
			return handleFailStage(ferment, cmd, ctx)
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
		case "set_stage_grade":
			return handleSetStageGrade(ferment, cmd, ctx)
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

function findStage(ferment: Ferment, stageId: string): { stage: Stage; index: number } | null {
	const index = ferment.stages.findIndex((p) => p.id === stageId)
	if (index < 0) return null
	return { stage: ferment.stages[index], index }
}

function requireStage(ferment: Ferment, stageId: string): { stage: Stage; index: number } | TransitionError {
	const found = findStage(ferment, stageId)
	if (!found) {
		return { code: "PHASE_NOT_FOUND", stageId: stageId, message: `Phase "${stageId}" not found.` }
	}
	return found
}

function requireStageStatus(stage: Stage, expected: StageStatus[]): TransitionError | null {
	if (expected.includes(stage.status)) return null
	return {
		code: "PHASE_NOT_IN_STATUS",
		stageId: stage.id,
		expected,
		actual: stage.status,
		message: `Phase "${stage.id}" is "${stage.status}", expected ${expected.map((s) => `"${s}"`).join(" or ")}.`,
	}
}

function findStep(stage: Stage, stepId: string): { step: Step; index: number } | null {
	const index = stage.steps.findIndex((s) => s.id === stepId)
	if (index < 0) return null
	return { step: stage.steps[index], index }
}

function requireStep(stage: Stage, stepId: string): { step: Step; index: number } | TransitionError {
	const found = findStep(stage, stepId)
	if (!found) {
		return { code: "STEP_NOT_FOUND", stepId, message: `Step "${stepId}" not found in phase "${stage.id}".` }
	}
	return found
}

function isTransitionError(v: unknown): v is TransitionError {
	return typeof v === "object" && v !== null && "code" in v && "message" in v
}

// ─── Field updates ────────────────────────────────────────────────────────────

function setStage(ferment: Ferment, stageIndex: number, patch: Partial<Stage>): Stage[] {
	return ferment.stages.map((p, i) => (i === stageIndex ? { ...p, ...patch } : p))
}

function setStageStep(ferment: Ferment, stageIndex: number, stepIndex: number, patch: Partial<Step>): Stage[] {
	return ferment.stages.map((p, i) => {
		if (i !== stageIndex) return p
		return {
			...p,
			steps: p.steps.map((s, j) => (j === stepIndex ? { ...s, ...patch } : s)),
		}
	})
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command handlers
// ═══════════════════════════════════════════════════════════════════════════════

// ─── scope ────────────────────────────────────────────────────────────────────
// Saves goal/criteria/constraints/phases and transitions draft → planned.

function handleScope(
	ferment: Ferment,
	cmd: Extract<Command, { type: "scope" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["draft"])
	if (guard) return fail(guard)

	const stages: Stage[] = cmd.phases.map((p, i) => {
		const steps: Step[] = (p.steps ?? []).map((st, si) => ({
			id: `step-${si + 1}`,
			index: si + 1,
			description: st.description,
			status: "pending" as const,
			verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
		}))
		return {
			id: `phase-${i + 1}`,
			index: i + 1,
			name: p.name,
			goal: p.goal,
			description: p.description ?? "",
			constraints: p.constraints,
			budget: p.budget,
			parallel: p.parallel_group !== undefined,
			groupIndex: p.parallel_group,
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
	if (stages.length > 0) {
		scoping.phases = { answer: stages.map((p) => p.name).join(", "), confirmedAt: ctx.now }
	}

	return ok(
		touch(ferment, ctx, {
			name: cmd.title ?? ferment.name,
			goal: cmd.goal,
			successCriteria: cmd.successCriteria,
			constraints: cmd.constraints,
			scoping,
			stages,
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
	} else {
		return fail({
			code: "INVALID_FIELD",
			field: cmd.field,
			message: `Unknown field: "${cmd.field}". Use goal, criteria, or constraints.`,
		})
	}

	return ok(touch(ferment, ctx, { ...patch, scoping }))
}

// ─── set_mode ─────────────────────────────────────────────────────────────────

function handleSetMode(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_mode" }>,
	ctx: TransitionContext,
): TransitionResult {
	if (!["plan", "exec", "auto"].includes(cmd.mode)) {
		return fail({
			code: "INVALID_MODE",
			mode: cmd.mode,
			message: `Invalid mode: "${cmd.mode}". Use plan, exec, or auto.`,
		})
	}
	return ok(touch(ferment, ctx, { mode: cmd.mode }))
}

// ─── rename ───────────────────────────────────────────────────────────────────

function handleRename(
	ferment: Ferment,
	cmd: Extract<Command, { type: "rename" }>,
	ctx: TransitionContext,
): TransitionResult {
	return ok(touch(ferment, ctx, { name: cmd.name }))
}

// ─── activate_stage ───────────────────────────────────────────────────────────

function handleActivateStage(
	ferment: Ferment,
	cmd: Extract<Command, { type: "activate_stage" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { stage, index } = found

	const guard = requireStageStatus(stage, ["planned", "failed"])
	if (guard) return fail(guard)

	const stages = activateSingleStage(ferment.stages, stage.id, ctx.now)

	return ok(
		touch(ferment, ctx, {
			stages,
			activeStageId: stage.id,
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
	const groupStages = ferment.stages.filter((p) => p.groupIndex === cmd.groupIndex && p.status === "planned")
	if (groupStages.length === 0) {
		return fail({
			code: "PHASE_GROUP_EMPTY",
			groupIndex: cmd.groupIndex,
			message: `No planned phases in group ${cmd.groupIndex}.`,
		})
	}

	const stages = ferment.stages.map((p) => {
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
			stages,
			activeStageId: groupStages[0].id,
			lastActiveAt: ctx.now,
			status: "running",
		}),
	)
}

// ─── refine_stage ─────────────────────────────────────────────────────────────

function handleRefineStage(
	ferment: Ferment,
	cmd: Extract<Command, { type: "refine_stage" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { stage, index } = found

	const guard = requireStageStatus(stage, ["active"])
	if (guard) return fail(guard)

	const running = stage.steps.find((s) => s.status === "running")
	if (running) {
		return fail({
			code: "STEP_RUNNING",
			stageId: stage.id,
			runningStepId: running.id,
			runningStepIndex: running.index,
			runningDescription: running.description,
			message: `Cannot refine phase ${stage.index} "${stage.name}" — step ${running.index} ("${running.description}") is currently running. Complete, skip, or fail it before refining.`,
		})
	}

	const steps: Step[] = cmd.steps.map((st, i) => ({
		id: `step-${i + 1}`,
		index: i + 1,
		description: st.description,
		status: "pending" as const,
		needsVision: st.needs_vision ?? false,
		workerModel: st.needs_vision ? "kimi-k2.5" : "minimax-m2.7",
		canRunParallel: st.can_run_parallel ?? false,
		verification: st.verify ? { command: st.verify, retries: 2, retryDelayMs: 1000 } : undefined,
	}))

	return ok(touch(ferment, ctx, { stages: setStage(ferment, index, { steps }) }))
}

// ─── start_step ───────────────────────────────────────────────────────────────

function handleStartStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "start_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { step, index: stepIndex } = stepFound

	const alreadyRunning = stage.steps.find((s) => s.status === "running" && s.id !== step.id)
	if (alreadyRunning && (!alreadyRunning.canRunParallel || !step.canRunParallel)) {
		return fail({
			code: "CONCURRENT_NON_PARALLEL_STEP",
			runningStepId: alreadyRunning.id,
			runningStepIndex: alreadyRunning.index,
			runningDescription: alreadyRunning.description,
			message: `Cannot start step ${step.index} — step ${alreadyRunning.index} ("${alreadyRunning.description}") is already running and is not parallel-safe.`,
		})
	}

	return ok(
		touch(ferment, ctx, {
			stages: setStageStep(ferment, stageIndex, stepIndex, { status: "running", startedAt: ctx.now }),
		}),
	)
}

// ─── complete_step ────────────────────────────────────────────────────────────

function handleCompleteStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const status: StepStatus = cmd.result?.success ? "verified" : "done"

	return ok(
		touch(ferment, ctx, {
			stages: setStageStep(ferment, stageIndex, stepIndex, {
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
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const status: StepStatus = cmd.result.success ? "verified" : "done"

	return ok(
		touch(ferment, ctx, {
			stages: setStageStep(ferment, stageIndex, stepIndex, {
				status,
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
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	return ok(
		touch(ferment, ctx, {
			stages: setStageStep(ferment, stageIndex, stepIndex, { status: "skipped", completedAt: ctx.now }),
		}),
	)
}

// ─── fail_step ────────────────────────────────────────────────────────────────

function handleFailStep(
	ferment: Ferment,
	cmd: Extract<Command, { type: "fail_step" }>,
	ctx: TransitionContext,
): TransitionResult {
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	const result: StepResult | undefined = cmd.error
		? { success: false, stderr: cmd.error, completedAt: ctx.now }
		: undefined

	return ok(
		touch(ferment, ctx, {
			stages: setStageStep(ferment, stageIndex, stepIndex, {
				status: "failed",
				completedAt: ctx.now,
				result,
			}),
		}),
	)
}

// ─── complete_stage ───────────────────────────────────────────────────────────

function handleCompleteStage(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_stage" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { stage, index } = found

	const guard = requireStageStatus(stage, ["active"])
	if (guard) return fail(guard)

	const stages = setStage(ferment, index, {
		status: "completed",
		summary: cmd.summary,
		completedAt: ctx.now,
		grade: cmd.grade,
	})

	return ok(touch(ferment, ctx, settleAfterStageTerminalPatch(stages)))
}

// ─── skip_stage ───────────────────────────────────────────────────────────────

function handleSkipStage(
	ferment: Ferment,
	cmd: Extract<Command, { type: "skip_stage" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	const stages = setStage(ferment, index, {
		status: "skipped",
		summary: cmd.reason ?? "Skipped",
		completedAt: ctx.now,
	})

	return ok(touch(ferment, ctx, settleAfterStageTerminalPatch(stages)))
}

// ─── fail_stage ───────────────────────────────────────────────────────────────

function handleFailStage(
	ferment: Ferment,
	cmd: Extract<Command, { type: "fail_stage" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	const stages = setStage(ferment, index, {
		status: "failed",
		summary: cmd.reason,
		completedAt: ctx.now,
	})

	return ok(touch(ferment, ctx, settleAfterStageTerminalPatch(stages)))
}

// ─── complete_ferment ─────────────────────────────────────────────────────────

function handleCompleteFerment(
	ferment: Ferment,
	cmd: Extract<Command, { type: "complete_ferment" }>,
	ctx: TransitionContext,
): TransitionResult {
	const nonTerminal = ferment.stages.filter((p) => !TERMINAL_STAGE_STATUSES.includes(p.status))
	if (nonTerminal.length > 0) {
		return fail({
			code: "PHASES_NOT_TERMINAL",
			nonTerminalIds: nonTerminal.map((p) => p.id),
			message: `Cannot complete: ${nonTerminal.length} phase(s) still active or planned: ${nonTerminal.map((p) => `"${p.name}"`).join(", ")}`,
		})
	}

	const patch: Partial<Ferment> = { status: "complete" }
	if (cmd.grade) patch.grade = cmd.grade
	return ok(touch(ferment, ctx, patch))
}

// ─── pause / resume ───────────────────────────────────────────────────────────

function handlePause(
	ferment: Ferment,
	_cmd: Extract<Command, { type: "pause" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["running", "planned"])
	if (guard) return fail(guard)
	return ok(touch(ferment, ctx, { status: "paused" }))
}

function handleResume(
	ferment: Ferment,
	_cmd: Extract<Command, { type: "resume" }>,
	ctx: TransitionContext,
): TransitionResult {
	const guard = requireFermentStatus(ferment, ["paused"])
	if (guard) return fail(guard)
	const activeStage = ferment.stages.find((p) => p.status === "active")
	return ok(
		touch(ferment, ctx, {
			status: activeStage ? "running" : "planned",
			activeStageId: activeStage?.id,
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
		phaseId: cmd.stageId,
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
		phaseId: cmd.stageId,
		stepId: cmd.stepId,
		createdAt: ctx.now,
	}
	return ok(touch(ferment, ctx, { memories: [...ferment.memories, memory] }))
}

// ─── set_stage_grade ──────────────────────────────────────────────────────────

function handleSetStageGrade(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_stage_grade" }>,
	ctx: TransitionContext,
): TransitionResult {
	const found = requireStage(ferment, cmd.stageId)
	if (isTransitionError(found)) return fail(found)
	const { index } = found

	return ok(touch(ferment, ctx, { stages: setStage(ferment, index, { grade: cmd.grade }) }))
}

// ─── set_step_grade ───────────────────────────────────────────────────────────

function handleSetStepGrade(
	ferment: Ferment,
	cmd: Extract<Command, { type: "set_step_grade" }>,
	ctx: TransitionContext,
): TransitionResult {
	const stageFound = requireStage(ferment, cmd.stageId)
	if (isTransitionError(stageFound)) return fail(stageFound)
	const { stage, index: stageIndex } = stageFound

	const stepFound = requireStep(stage, cmd.stepId)
	if (isTransitionError(stepFound)) return fail(stepFound)
	const { index: stepIndex } = stepFound

	return ok(touch(ferment, ctx, { stages: setStageStep(ferment, stageIndex, stepIndex, { grade: cmd.grade }) }))
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

export { TERMINAL_STAGE_STATUSES, TERMINAL_STEP_STATUSES, VALID_MEMORY_CATEGORIES }
export { TERMINAL_STAGE_STATUSES as TERMINAL_PHASE_STATUSES }
