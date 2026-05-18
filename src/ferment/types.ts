/**
 * Ferment v4 — Progressive Refinement Types
 *
 * Unifies PlannedBatch + BatchRef into Phase.
 * Moves recipes into persisted Step[] within Phase.
 * 5-state lifecycle: draft → planned → running → paused → complete.
 * Added: git worktree tracking + scoping questionnaire validation.
 */

// ─── Task / Level 0 ───────────────────────────────────────────────────────────

export type FermentStatus = "draft" | "planned" | "running" | "paused" | "complete" | "abandoned"

export type FermentWorkMode = "plan" | "exec" | "auto"

export interface FermentWorktree {
	/** Absolute path to project root */
	path: string
	/** Git branch when ferment was created */
	branch?: string
	/** HEAD commit when ferment was created */
	commit?: string
}

export interface ScopingAnswer {
	answer: string
	confirmedAt: string
}

export interface ScopingQuestionOption {
	id: string
	label: string
	recommended?: boolean
}

export interface ScopingQuestion {
	id: string
	text: string
	options: ScopingQuestionOption[]
}

export interface Scoping {
	/** The goal that was collected and confirmed */
	goal?: ScopingAnswer
	/** The success criteria that was collected and confirmed */
	criteria?: ScopingAnswer
	/** The constraints that were collected and confirmed */
	constraints?: ScopingAnswer
	/** Whether phases have been proposed/accepted */
	phases?: ScopingAnswer
	/** Assumptions the team is operating under (optional) */
	assumptions?: ScopingAnswer
}

export interface Ferment {
	id: string
	name: string
	description?: string
	tags?: string[]

	goal?: string
	successCriteria?: string
	constraints?: string[]

	status: FermentStatus
	mode: FermentWorkMode
	activePhaseId?: string
	lastActiveAt?: string

	/** Git worktree where this ferment was started */
	worktree: FermentWorktree
	/** Scoping questionnaire state */
	scoping: Scoping

	phases: Phase[]
	decisions: Decision[]
	memories: Memory[]

	grade?: JudgeGrade // computed at complete_ferment from phase grades

	createdAt: string
	updatedAt: string
}

// ─── Phase / Level 1 ──────────────────────────────────────────────────────────

export type PhaseStatus = "planned" | "active" | "completed" | "skipped" | "failed"

export interface Phase {
	id: string
	index: number // 1-based for display
	name: string
	description?: string
	goal: string // what THIS phase delivers
	constraints?: string[] // per-phase boundaries
	budget?: string // e.g. "200k tokens"

	status: PhaseStatus
	startedAt?: string
	completedAt?: string
	summary?: string // what was accomplished
	grade?: JudgeGrade // set by judge at complete_phase

	// Progressive refinement: steps are populated when phase is activated
	steps: Step[]

	// Parallel execution (v4.1)
	parallel?: boolean
	groupIndex?: number // phases with same groupIndex run together
}

// ─── Grading ──────────────────────────────────────────────────────────────────

export type Grade = "A" | "B" | "C" | "D" | "F"

export interface Delta {
	category: "scope" | "quality" | "completeness" | "timing" | "correctness" | "other"
	expected: string
	actual: string
	severity: "major" | "minor" | "cosmetic"
}

export interface JudgeGrade {
	grade: Grade
	rationale: string
	gradedAt: string
	deltas?: Delta[]
	/** True when the journey-grade judge was unreachable or returned
	 *  unparseable output at complete_ferment and the user authorized an
	 *  ungraded ship. The grade field carries a placeholder ("B") so legacy
	 *  consumers don't break, but stats should check this flag first and
	 *  skip the entry when set — otherwise judge outages look like a string
	 *  of B grades. */
	unavailable?: boolean
}

// ─── Step / Level 2 (replaces RecipeStep) ─────────────────────────────────────

export type StepStatus = "pending" | "running" | "done" | "skipped" | "verified" | "failed"

/** True when both items are members of the same non-singleton parallel group.
 *  Shared by the transition state machine (Step) and the FSM (StepContext)
 *  since both carry the same parallel/groupIndex pair.
 *
 *  Set `KIMCHI_FERMENT_DISABLE_PARALLEL=1` to globally collapse all parallel
 *  cohorts back to sequential execution — useful when investigating issues
 *  that might stem from concurrency. */
export function inSameParallelCohort(
	a: { parallel?: boolean; groupIndex?: number },
	b: { parallel?: boolean; groupIndex?: number },
): boolean {
	if (process.env.KIMCHI_FERMENT_DISABLE_PARALLEL === "1") return false
	return !!a.parallel && !!b.parallel && a.groupIndex !== undefined && a.groupIndex === b.groupIndex
}

export interface Step {
	id: string
	index: number // 1-based
	description: string

	status: StepStatus
	startedAt?: string
	completedAt?: string

	// Parallel execution — symmetric with Phase. Steps that share groupIndex
	// inside the same phase run concurrently; `parallel` is the derived "this
	// step is a member of a cohort of size ≥ 2" flag.
	parallel?: boolean
	groupIndex?: number

	verification?: Verification
	result?: StepResult // populated on completion/verification
	grade?: JudgeGrade // set by judge after step completes

	/** Short summary of what the worker accomplished. Set by complete_step.
	 *  Surfaced in worker context for subsequent steps in the same phase
	 *  so they don't redo work or miss prior decisions. */
	summary?: string
}

export interface Verification {
	command: string
	retries?: number // default 2
	retryDelayMs?: number // default 1000
}

export interface StepResult {
	success: boolean
	stdout?: string
	stderr?: string
	exitCode?: number
	completedAt: string
}

// ─── Decision / Memory ────────────────────────────────────────────────────────

export interface Decision {
	id: string // D001, D002...
	title: string
	description: string
	phaseId?: string
	stepId?: string
	createdAt: string
}

export type MemoryCategory = "architecture" | "convention" | "gotcha" | "pattern" | "preference"

export interface Memory {
	id: string // M001, M002...
	category: MemoryCategory
	content: string
	phaseId?: string
	stepId?: string
	createdAt: string
}

// ─── Action — what the engine says the LLM should do next ─────────────────────

export type FermentAction =
	| { kind: "scope"; message: string } // ask user for goal + phases
	| { kind: "refine"; phaseId: string; message: string } // populate steps
	| { kind: "start_step"; stepId: string; message: string } // begin work
	| { kind: "verify"; stepId: string; message: string } // run verify command
	| { kind: "complete_step"; stepId: string; message: string } // step done
	| { kind: "complete_phase"; phaseId: string; message: string } // phase done
	| { kind: "activate_phase"; phaseId: string; message: string } // start next
	| { kind: "complete_ferment"; message: string } // all done
	| { kind: "paused"; message: string } // wait for user
	| { kind: "recover_step"; stepId: string; phaseId: string; message: string } // failed step recovery
	| { kind: "recover_phase"; phaseId: string; message: string } // failed phase recovery

// ─── Custom session entry types ───────────────────────────────────────────────

export interface FermentReferenceData {
	fermentId: string
}

// ─── Legacy (v3) upgrade helpers ──────────────────────────────────────────────

/** v3 Ferment format for migration */
export interface FermentV3 {
	id: string
	name: string
	description?: string
	goal?: string
	successCriteria?: string
	status: // old 7-state
	"pending_goal" | "planned" | "batch_planned" | "executing" | "paused" | "completed" | "abandoned"
	createdAt: string
	updatedAt: string
	batchRefs: {
		id: string
		name?: string
		plannedBatchId?: string
		status: string
		summary?: string
		completedAt?: string
	}[]
	plannedBatches: {
		id: string
		index: number
		name: string
		description: string
		goal: string
		status: string
		actualBatchId?: string
	}[]
	decisions?: Decision[]
	memories?: Memory[]
}
