import type { FermentV2EvaluatorUsage, SessionFermentV2 } from "./types.js"

export const FERMENT_V2_EVENTS = {
	STARTED: "ferment-v2:started",
	REPLACED: "ferment-v2:replaced",
	EDITED: "ferment-v2:edited",
	RESUMED: "ferment-v2:resumed",
	COMPLETED: "ferment-v2:completed",
	BLOCKED: "ferment-v2:blocked",
	PAUSED: "ferment-v2:paused",
	CLEARED: "ferment-v2:cleared",
	BUDGET_LIMITED: "ferment-v2:budget_limited",
	STALLED: "ferment-v2:stalled",
	AGENT_ERROR: "ferment-v2:agent_error",
	EVALUATED: "ferment-v2:evaluated",
	CONTEXT_CHANGED: "ferment-v2:context_changed",
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
		| "agent_declared"
		| "evaluator_impossible"
		| "agent_aborted"
		| "agent_errors"
		| "no_progress"
		| "evaluator_unavailable"
		| "final_answer_delivery_failed"
		| "token_budget"
	continuationCount?: number
	replacementFermentV2Id?: string
	consecutiveErrorCount?: number
}

export type FermentV2EvaluatorFailureType =
	| "no_model"
	| "todo_state_too_large"
	| "auth_unavailable"
	| "redaction_failed"
	| "timeout"
	| "cancelled"
	| "truncated_output"
	| "invalid_output"
	| "budget_exhausted"
	| "rate_limit"
	| "transport_failure"
	| "stream_interrupted"
	| "provider_5xx"
	| "provider_error"
	| "bad_request"
	| "content_filter"
	| "context_window_exceeded"
	| "invalid_request_payload"
	| "model_retired"
	| "call_failed"

export interface FermentV2EvaluatedPayload {
	sessionId: string
	fermentV2Id: string
	revision: number
	status: SessionFermentV2["status"]
	verdict: "continue" | "met" | "impossible" | "unavailable"
	count: number
	model?: string
	usage?: FermentV2EvaluatorUsage
	durationMs: number
	timeoutMs: number
	providerRequestCount: number
	timeoutCount: number
	correctionCount: number
	failureType?: FermentV2EvaluatorFailureType
	httpStatusCode?: number
}

export interface FermentV2ContextChangedPayload {
	fermentV2Id?: string
	revision?: number
	status?: SessionFermentV2["status"]
}
