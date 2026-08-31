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

/**
 * A narrowed, self-contained projection of pi-ai's `Usage` — only the fields
 * this feature persists and sums (benchmark cost aggregation reads the
 * input/output/cache breakdown; nothing reads a per-category cost split, so
 * only the total is kept). Decoupled from `Usage` so an unrelated field pi-ai
 * adds later can't change what this journal schema accepts.
 */
export interface FermentV2EvaluatorUsage {
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
}

export interface SessionFermentV2 {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	status: FermentV2Status
	blockedReason?: string
	completionConfidence?: FermentV2CompletionConfidence
	evaluationCount?: number
	lastEvaluation?: FermentV2Evaluation
	evaluatorUsage?: FermentV2EvaluatorUsage
	/**
	 * Runaway-loop guard counters; the limits that trip them are
	 * getFermentV2Settings().maxConsecutiveErrors / maxUnchangedContinuations
	 * (settings.ts), user-configurable and 3 by default. Persisted so a
	 * session restart mid-stall reseeds the in-memory guard instead of
	 * silently zeroing it — omitted (treated as 0) whenever there's no
	 * streak to record.
	 */
	consecutiveErrorTurns?: number
	unchangedContinuationTurns?: number
	tokensUsed: number
	tokenBudget?: number
	timeUsedMs: number
	createdAt: string
	updatedAt: string
}

export interface FermentV2EvaluatorUsageJournalEntry {
	schemaVersion: 1
	op: "evaluator_usage"
	sessionId: string
	fermentV2Id: string
	revision: number
	usage: FermentV2EvaluatorUsage
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
	| FermentV2EvaluatorUsageJournalEntry

export interface PendingFermentV2Continuation {
	sessionId: string
	fermentV2Id: string
	revision: number
}
