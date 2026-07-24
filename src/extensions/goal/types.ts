export const GOAL_STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"] as const

export type GoalStatus = (typeof GOAL_STATUSES)[number]

export interface SessionGoal {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	status: GoalStatus
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

export type GoalTurnAttribution = PendingGoalContinuation
