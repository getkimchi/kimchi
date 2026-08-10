import type { Usage } from "@earendil-works/pi-ai"
import type { ChangeSetStats, ChangeTransactionState } from "../../agent-patch/index.js"
import type { ValidationCheckKind, ValidationMutationPolicy } from "./validation.js"

export const MAX_COUNCIL_PANEL_SIZE = 5
export type CouncilStage = "lead" | "solver" | "analyst" | "synthesis" | "combined" | "repair"
export type CouncilRole = CouncilStage
export type CouncilSchemaErrorCode =
	| "missing_json"
	| "ambiguous_json"
	| "invalid_json"
	| "invalid_shape"
	| "unsupported_reference"
export type CouncilOutcome = "accepted" | "tool_use" | "degraded" | "error" | "aborted"
export type CouncilTransactionProgressPhase =
	| "exploring"
	| "solving"
	| "comparing"
	| "writing"
	| "applying"
	| "checking"
export type SafeCouncilFailureReason =
	| "cancelled"
	| "timed_out"
	| "panel_unavailable"
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
			outcome: "accepted" | "tool_use" | "degraded"
			durationMs: number
			estimatedCostUsd?: number
	  }
	| {
			type: "run_failed" | "run_aborted"
			runId: string
			durationMs: number
			reason: SafeCouncilFailureReason
	  }
export type CouncilDegradedReason =
	| "panel_unavailable"
	| "self_fusion"
	| "structured_output_invalid"
	| "budget_exhausted"
	| "deadline_exceeded"
	| "insufficient_evidence"
	| "analyst_failed"
	| "budget_exceeded"
	| "structured_output_failed"
	| "synthesis_failed"
	| "context_compilation_failed"
	| "no_validation_checks"
	| "no_changes_needed"

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
	maxRetriesPerCall: number
}

export interface CouncilConfig {
	enabled: boolean
	lead: CouncilModelPool
	panel: CouncilModelPool[]
	analyst: CouncilModelPool
	panelSize: number
	panelSizeOverride?: number
	overallTimeoutMs: number
	stageTimeoutMs: number
	leadMaxTokens: number
	internalMaxTokens: number
	maxEvidenceBytes: number
	maxStructuredBytes: number
	budget: CouncilBudgetLimits
}

export interface CouncilBudgetUsage {
	logicalCalls: number
	physicalAttempts: number
	maxObservedConcurrency: number
	aggregateInputTokens: number
	aggregateOutputTokens: number
	evidenceBytes: number
	structuredBytes: number
	cacheHits: number
	cacheMisses: number
}

export interface CouncilStageRecord {
	stage: CouncilStage
	modelRef: string
	status: "ok" | "degraded" | "error" | "aborted"
	durationMs: number
	attempts: number
	usage?: Usage
	error?: string
	schemaErrorCode?: CouncilSchemaErrorCode
	truncated?: boolean
	retry?: boolean
	fallback?: boolean
	cacheHit?: boolean
}

export interface CouncilTransactionSnapshot {
	transactionId: string
	state: ChangeTransactionState
	outcome: "pending" | "applied" | "discarded" | "rolled_back" | "failed" | "hard_recovery"
	patchSha256?: string
	stats?: ChangeSetStats
	baseVerification: "not_run" | "passed" | "failed"
	selectedValidationCheckIds: string[]
	postApplyChecks: Array<{
		id: string
		kind: ValidationCheckKind
		toolName: string
		command: string
		ok: boolean
		exitCode: number | null
		durationMs: number
		beforeSha256: string
		afterSha256?: string
		mutationPolicy: ValidationMutationPolicy
		mutation: "none" | "expected_only" | "unexpected_restored" | "unexpected_restore_failed"
	}>
	rollbackState: "not_available" | "available" | "completed" | "failed"
	hardRecoveryRequired: boolean
}

export interface CouncilRunRecord {
	runId: string
	virtualModel: string
	outcome: CouncilOutcome
	degradedReason?: CouncilDegradedReason
	durationMs: number
	stages: CouncilStageRecord[]
	usage: Usage
	budget: CouncilBudgetUsage
	transaction?: CouncilTransactionSnapshot
}
