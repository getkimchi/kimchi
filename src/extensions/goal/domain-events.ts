import type { SessionGoal } from "./types.js"

export const GOAL_EVENTS = {
	STARTED: "goal:started",
	REPLACED: "goal:replaced",
	EDITED: "goal:edited",
	COMPLETED: "goal:completed",
	BLOCKED: "goal:blocked",
	PAUSED: "goal:paused",
	STALLED: "goal:stalled",
	EVALUATED: "goal:evaluated",
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
	reason?: "user" | "agent_aborted" | "agent_errors" | "no_progress" | "evaluator_unavailable"
	continuationCount?: number
}

export interface GoalEvaluatedPayload {
	goalId: string
	verdict: "continue" | "met" | "impossible"
	count: number
	model: string
	usage: NonNullable<SessionGoal["evaluatorUsage"]>
}
