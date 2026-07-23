import type { Usage } from "@earendil-works/pi-ai"
import type { ChangeSetStats, ChangeTransactionState } from "../../agent-patch/index.js"

export const REQUIRED_REVIEWER_ROLES = ["independent", "critic", "checker"] as const

export type ReviewerRole = (typeof REQUIRED_REVIEWER_ROLES)[number]
export type CouncilStage = "lead" | ReviewerRole | "judge" | "repair" | "revision"
export type CouncilRole = CouncilStage
export type CouncilOutcome = "accepted" | "revised" | "tool_use" | "degraded" | "error" | "aborted"
export type CouncilTransactionProgressPhase =
	| "preparing_candidate"
	| "validating_patch"
	| "reviewing"
	| "adjudicating"
	| "revising"
	| "applying"
export type SafeCouncilFailureReason =
	| "cancelled"
	| "timed_out"
	| "review_unavailable"
	| "validation_failed"
	| "limit_reached"

export type CouncilProgressEvent =
	| {
			type: "run_started"
			runId: string
			preset: "fast" | "normal" | "deep"
			startedAt: number
	  }
	| {
			type: "stage_started"
			runId: string
			stageId: string
			role: CouncilRole
			startedAt: number
	  }
	| {
			type: "stage_completed"
			runId: string
			stageId: string
			role: CouncilRole
			durationMs: number
	  }
	| {
			type: "stage_failed"
			runId: string
			stageId: string
			role: CouncilRole
			durationMs: number
			reason: SafeCouncilFailureReason
	  }
	| {
			type: "transaction_progress"
			runId: string
			phase: CouncilTransactionProgressPhase
	  }
	| {
			type: "run_completed"
			runId: string
			outcome: "accepted" | "revised" | "tool_use" | "degraded"
			durationMs: number
			agreement?: "low" | "medium" | "high"
			estimatedCostUsd?: number
	  }
	| {
			type: "run_failed" | "run_aborted"
			runId: string
			durationMs: number
			reason: SafeCouncilFailureReason
	  }
export type CouncilDegradedReason =
	| "partial_panel"
	| "judge_unavailable"
	| "structured_output_invalid"
	| "budget_exhausted"
	| "deadline_exceeded"
	| "revision_failed"
	| "insufficient_evidence"
	| "reviewer_failed"
	| "reviewers_unavailable"
	| "judge_failed"
	| "budget_exceeded"
	| "structured_output_failed"

export interface CouncilModelPool {
	primary: string
	fallbacks: string[]
}

export interface CouncilBudgetLimits {
	maxLogicalCalls: number
	maxPhysicalAttempts: number
	maxConcurrentCalls: number
	maxAggregateInputTokens: number
	maxAggregateOutputTokens: number
	maxEstimatedCostUsd: number
	maxRetriesPerCall: number
}

export interface CouncilConfig {
	enabled: boolean
	reviewPolicy: "always" | "changes"
	lead: CouncilModelPool
	reviewers: Record<ReviewerRole, CouncilModelPool>
	judge: CouncilModelPool
	requiredRoles: ReviewerRole[]
	maxParallelReviewers: number
	overallTimeoutMs: number
	stageTimeoutMs: number
	leadMaxTokens: number
	internalMaxTokens: number
	maxEvidenceBytes: number
	maxStructuredBytes: number
	/** @deprecated Use budget.maxLogicalCalls. */
	maxCalls: number
	budget: CouncilBudgetLimits
	useJudge: boolean
	revisionPolicy: "always" | "on-issues"
}

export interface CouncilBudgetUsage {
	logicalCalls: number
	physicalAttempts: number
	maxObservedConcurrency: number
	aggregateInputTokens: number
	aggregateOutputTokens: number
	estimatedCostUsd: number
	evidenceBytes: number
	structuredBytes: number
}

export interface CouncilStageRecord {
	stage: CouncilStage
	modelRef: string
	status: "ok" | "degraded" | "error" | "aborted"
	durationMs: number
	attempts: number
	usage?: Usage
	error?: string
	truncated?: boolean
	retry?: boolean
	fallback?: boolean
}

export interface CouncilTransactionSnapshot {
	transactionId: string
	state: ChangeTransactionState
	outcome: "pending" | "applied" | "discarded" | "rolled_back" | "failed" | "hard_recovery"
	patchSha256?: string
	stats?: ChangeSetStats
	baseVerification: "not_run" | "passed" | "failed"
	revisionCount: number
	postApplyChecks: Array<{ toolName: string; ok: boolean }>
	rollbackState: "not_available" | "available" | "completed" | "failed"
	hardRecoveryRequired: boolean
}

export interface CouncilRunRecord {
	runId: string
	virtualModel: string
	outcome: CouncilOutcome
	degradedReason?: CouncilDegradedReason
	agreement?: "low" | "medium" | "high"
	unresolvedFindingCount: number
	missingReviewerRoles: ReviewerRole[]
	durationMs: number
	stages: CouncilStageRecord[]
	usage: Usage
	budget: CouncilBudgetUsage
	transaction?: CouncilTransactionSnapshot
}
