export const GOAL_STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"] as const
export const GOAL_COMPLETION_CONFIDENCES = ["guess", "partial", "tested", "proven"] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]
type GoalCompletionConfidence = (typeof GOAL_COMPLETION_CONFIDENCES)[number]

export interface SessionGoal {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	status: GoalStatus
	completionConfidence?: GoalCompletionConfidence
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
