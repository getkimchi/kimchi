import type { SessionGoal } from "./types.js"

export const GOAL_EVENTS = {
	STARTED: "goal:started",
	REPLACED: "goal:replaced",
	EDITED: "goal:edited",
	COMPLETED: "goal:completed",
	BLOCKED: "goal:blocked",
} as const

export type GoalEventName = (typeof GOAL_EVENTS)[keyof typeof GOAL_EVENTS]

export interface GoalLifecyclePayload {
	goalId: string
	revision: number
	status: SessionGoal["status"]
	tokensUsed: number
	timeUsedMs: number
	tokenBudget?: number
	completionConfidence?: SessionGoal["completionConfidence"]
}
