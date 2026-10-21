export const FERMENT_V2_STATUS = {
	ACTIVE: "active",
	PAUSED: "paused",
	BLOCKED: "blocked",
	BUDGET_LIMITED: "budget_limited",
	COMPLETE: "complete",
} as const
export const FERMENT_V2_STATUSES = Object.values(FERMENT_V2_STATUS)
export const FERMENT_V2_COMPLETION_CONFIDENCES = ["guess", "partial", "tested", "proven"] as const
export const FERMENT_V2_EVALUATION_VERDICTS = ["continue", "met", "impossible", "unavailable"] as const

export type FermentV2Status = (typeof FERMENT_V2_STATUSES)[number]
export type FermentV2CompletionConfidence = (typeof FERMENT_V2_COMPLETION_CONFIDENCES)[number]
export type FermentV2EvaluationVerdict = (typeof FERMENT_V2_EVALUATION_VERDICTS)[number]

export interface FermentV2Evaluation {
	verdict: FermentV2EvaluationVerdict
	reason: string
	model?: string
	/** True when the evaluator ran on the implementer's own session model. */
	sameModelAsImplementer?: boolean
	evaluatedAt: string
}

export interface FermentV2EvaluatorUsage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
}

export interface FermentV2Presentation {
	kind: "approved-plan"
	title: string
	planPath?: string
	planText?: string
}

export interface SessionFermentV2 {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	name?: string
	status: FermentV2Status
	presentation?: FermentV2Presentation
	blockedReason?: string
	completionConfidence?: FermentV2CompletionConfidence
	evaluationCount?: number
	lastEvaluation?: FermentV2Evaluation
	/** Set once the user has been warned that the evaluator runs on the implementer's model, so the warning fires once per ferment even across resume. */
	evaluatorModelWarned?: boolean
	consecutiveErrorTurns?: number
	unchangedContinuationTurns?: number
	tokensUsed: number
	tokenBudget?: number
	timeUsedMs: number
	/** Cumulative executing-verifier usage, tracked separately from the implementer's tokens. */
	verifierUsage?: FermentV2VerifierUsage
	/** Working-tree snapshot the verifier's facts, flags, and baseline worktree are anchored to. */
	baseline?: FermentV2Baseline
	createdAt: string
	updatedAt: string
}

export interface FermentV2VerifierUsage {
	runs: number
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
}

/**
 * Baseline snapshot of the working tree, captured when a ferment is created or
 * replaced (approved-plan starts included): a snapshot commit of every
 * untracked, non-ignored file alongside the tracked content. Absent outside a
 * git repository or when the snapshot failed — verification then runs without
 * baseline facts, flags, or a baseline worktree. Preserved on objective edit.
 */
export interface FermentV2Baseline {
	commit: string
	capturedAt: string
}

export type FermentV2JournalEntry =
	| {
			schemaVersion: 1
			op: "put"
			fermentV2: SessionFermentV2
	  }
	| {
			schemaVersion: 1
			op: "clear"
			fermentV2Id: string
			revision: number
			clearedAt: string
	  }

export interface PendingFermentV2Continuation {
	sessionId: string
	fermentV2Id: string
	revision: number
}
