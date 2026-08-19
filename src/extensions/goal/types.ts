export const GOAL_STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"] as const
export const GOAL_COMPLETION_CONFIDENCES = ["guess", "partial", "tested", "proven"] as const
export const GOAL_EVALUATION_VERDICTS = ["continue", "met", "impossible", "unavailable"] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]
export type GoalCompletionConfidence = (typeof GOAL_COMPLETION_CONFIDENCES)[number]
export type GoalEvaluationVerdict = (typeof GOAL_EVALUATION_VERDICTS)[number]

export interface GoalEvaluation {
	verdict: GoalEvaluationVerdict
	reason: string
	model?: string
	evaluatedAt: string
}

/**
 * A narrowed, self-contained projection of pi-ai's `Usage` — only the fields
 * this feature persists and sums (benchmark cost aggregation reads the
 * input/output/cache breakdown; nothing reads a per-category cost split, so
 * only the total is kept). Decoupled from `Usage` so an unrelated field pi-ai
 * adds later can't change what this journal schema accepts.
 */
export interface GoalEvaluatorUsage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
}

export interface SessionGoal {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	status: GoalStatus
	completionConfidence?: GoalCompletionConfidence
	evaluationCount?: number
	lastEvaluation?: GoalEvaluation
	evaluatorUsage?: GoalEvaluatorUsage
	tokensUsed: number
	tokenBudget?: number
	timeUsedMs: number
	createdAt: string
	updatedAt: string
}

export type GoalJournalEntry =
	| {
			schemaVersion: 1
			op: "put"
			goal: SessionGoal
	  }
	| {
			schemaVersion: 1
			op: "clear"
			goalId: string
			revision: number
			clearedAt: string
	  }

export interface PendingGoalContinuation {
	sessionId: string
	goalId: string
	revision: number
}
