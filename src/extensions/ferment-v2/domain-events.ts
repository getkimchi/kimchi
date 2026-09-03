import type { FermentV2EvaluatorUsage, SessionFermentV2 } from "./types.js"

export const FERMENT_V2_EVENTS = {
	STARTED: "ferment-v2:started",
	REPLACED: "ferment-v2:replaced",
	EDITED: "ferment-v2:edited",
	COMPLETED: "ferment-v2:completed",
	BLOCKED: "ferment-v2:blocked",
	PAUSED: "ferment-v2:paused",
	STALLED: "ferment-v2:stalled",
	EVALUATED: "ferment-v2:evaluated",
} as const

export type FermentV2EventName = (typeof FERMENT_V2_EVENTS)[keyof typeof FERMENT_V2_EVENTS]

export interface FermentV2LifecyclePayload {
	fermentV2Id: string
	revision: number
	status: SessionFermentV2["status"]
	tokensUsed: number
	timeUsedMs: number
	tokenBudget?: number
	completionConfidence?: SessionFermentV2["completionConfidence"]
	reason?:
		| "user"
		| "agent_aborted"
		| "agent_errors"
		| "no_progress"
		| "evaluator_unavailable"
		| "final_answer_delivery_failed"
	continuationCount?: number
}

export interface FermentV2EvaluatedPayload {
	fermentV2Id: string
	verdict: "continue" | "met" | "impossible"
	count: number
	model: string
	usage: FermentV2EvaluatorUsage
}
