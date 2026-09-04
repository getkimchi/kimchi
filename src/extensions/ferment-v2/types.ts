export const FERMENT_V2_STATUSES = ["active", "paused", "blocked", "budget_limited", "complete"] as const
export const FERMENT_V2_COMPLETION_CONFIDENCES = ["guess", "partial", "tested", "proven"] as const
export const FERMENT_V2_EVALUATION_VERDICTS = ["continue", "met", "impossible", "unavailable"] as const

export type FermentV2Status = (typeof FERMENT_V2_STATUSES)[number]
export type FermentV2CompletionConfidence = (typeof FERMENT_V2_COMPLETION_CONFIDENCES)[number]
export type FermentV2EvaluationVerdict = (typeof FERMENT_V2_EVALUATION_VERDICTS)[number]

export interface FermentV2Evaluation {
	verdict: FermentV2EvaluationVerdict
	reason: string
	model?: string
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
	status: FermentV2Status
	presentation?: FermentV2Presentation
	blockedReason?: string
	completionConfidence?: FermentV2CompletionConfidence
	evaluationCount?: number
	lastEvaluation?: FermentV2Evaluation
	consecutiveErrorTurns?: number
	unchangedContinuationTurns?: number
	tokensUsed: number
	tokenBudget?: number
	timeUsedMs: number
	createdAt: string
	updatedAt: string
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
