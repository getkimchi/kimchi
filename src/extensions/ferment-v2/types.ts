import type { VerifierRequirement } from "./requirements.js"

export const FERMENT_V2_STATUS = {
	ACTIVE: "active",
	PAUSED: "paused",
	BLOCKED: "blocked",
	BUDGET_LIMITED: "budget_limited",
	COMPLETE: "complete",
} as const
export const FERMENT_V2_STATUSES = Object.values(FERMENT_V2_STATUS)
export const FERMENT_V2_COMPLETION_CONFIDENCES = ["guess", "partial", "tested", "proven"] as const
export const FERMENT_V2_EVALUATION_VERDICTS = ["continue", "met", "impossible", "unavailable"] as const

export type FermentV2Status = (typeof FERMENT_V2_STATUSES)[number]
export type FermentV2CompletionConfidence = (typeof FERMENT_V2_COMPLETION_CONFIDENCES)[number]
export type FermentV2EvaluationVerdict = (typeof FERMENT_V2_EVALUATION_VERDICTS)[number]

export interface FermentV2Evaluation {
	verdict: FermentV2EvaluationVerdict
	reason: string
	model?: string
	/** True when the evaluator ran on the implementer's own session model. */
	sameModelAsImplementer?: boolean
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

/** Where the requirements draft ran: before implementation, from the fixed baseline after work started, or from the objective alone. */
export const FERMENT_V2_REQUIREMENTS_PROVENANCE = ["pre_implementation", "baseline_recovery", "objective_only"] as const
export type FermentV2RequirementsProvenance = (typeof FERMENT_V2_REQUIREMENTS_PROVENANCE)[number]

export const FERMENT_V2_REQUIREMENTS_AVAILABILITY = ["pending", "ready", "unavailable"] as const
export type FermentV2RequirementsAvailability = (typeof FERMENT_V2_REQUIREMENTS_AVAILABILITY)[number]

/** One accepted requirements revision, retained immutably. */
export interface FermentV2RequirementsRevision {
	/** Contract version this acceptance produced (1-based; never reused). */
	version: number
	items: readonly VerifierRequirement[]
	/** Lifecycle phase that accepted the list (for example `requirements_draft`). */
	actor: string
	reason?: string
	/** Ferment revision the accepted list targets. */
	objectiveRevision: number
	acceptedAt: string
}

/**
 * One rejected amendment proposal, retained so an exact duplicate (same
 * contract version, same list, same evidence) is answered from the cache
 * instead of spending another ruling; changed evidence or a changed version
 * permits reconsideration.
 */
export interface FermentV2RejectedAmendment {
	/** sha256 over {contractVersion, items, reason} — the exact proposal identity. */
	digest: string
	/** The contract version the proposal targeted. */
	contractVersion: number
	/** The ruling's source-grounded rejection reason (truncated). */
	reason: string
	decidedAt: string
}

/**
 * The one durable requirements record for a goal. `objectiveText` and
 * `objectiveDigest` pin the exact objective the contract was drafted for, so
 * editing an objective file cannot silently rewrite the criteria; a contract
 * whose `objectiveRevision` lags the ferment's current revision is stale for
 * verification but keeps its accepted history.
 */
export interface FermentV2Requirements {
	schemaVersion: 1
	/** Monotonically increasing; 0 = no list accepted yet, +1 per accepted list. */
	contractVersion: number
	objectiveRevision: number
	/** Hex sha256 of the exact resolved objective text the contract targets. */
	objectiveDigest: string
	/** Exact resolved objective text used for the drafting decision. */
	objectiveText: string
	/** The fixed goal baseline the draft (or a recovery draft) is anchored to, when one exists. */
	baselineCommit?: string
	provenance: FermentV2RequirementsProvenance
	availability: FermentV2RequirementsAvailability
	/** Concise reason when availability is `unavailable`. */
	unavailableReason?: string
	items: readonly VerifierRequirement[]
	/** Highest `r<n>` ID ever allocated; retired IDs are not reused. */
	idWatermark: number
	history: readonly FermentV2RequirementsRevision[]
	/** The one degraded-outage retry at a completion claim has been spent. */
	draftRetried?: boolean
	/** Recent rejected amendment proposals (bounded, newest last); exact duplicates short-circuit without a new ruling. */
	rejectedProposals?: readonly FermentV2RejectedAmendment[]
}

export interface SessionFermentV2 {
	schemaVersion: 1
	id: string
	revision: number
	objective: string
	name?: string
	status: FermentV2Status
	presentation?: FermentV2Presentation
	blockedReason?: string
	completionConfidence?: FermentV2CompletionConfidence
	evaluationCount?: number
	lastEvaluation?: FermentV2Evaluation
	/** Set once the user has been warned that the evaluator runs on the implementer's model, so the warning fires once per ferment even across resume. */
	evaluatorModelWarned?: boolean
	consecutiveErrorTurns?: number
	unchangedContinuationTurns?: number
	tokensUsed: number
	tokenBudget?: number
	timeUsedMs: number
	/** Cumulative executing-verifier usage, tracked separately from the implementer's tokens. */
	verifierUsage?: FermentV2VerifierUsage
	/** Cumulative requirements-draft stage usage, tracked separately from the implementer's tokens. */
	requirementsUsage?: FermentV2VerifierUsage
	/** Cumulative requirements-amendment ruling stage usage, tracked separately from the implementer's tokens. */
	amendmentsUsage?: FermentV2VerifierUsage
	/** The goal-owned durable requirements record; absent on sessions created before it existed. */
	requirements?: FermentV2Requirements
	/** Working-tree snapshot the verifier's facts, flags, and baseline worktree are anchored to. */
	baseline?: FermentV2Baseline
	createdAt: string
	updatedAt: string
}

export interface FermentV2VerifierUsage {
	runs: number
	input: number
	output: number
	cacheRead: number
	cacheWrite: number
	totalTokens: number
	costUsd: number
}

/**
 * Baseline snapshot of the working tree, captured when a ferment is created or
 * replaced (approved-plan starts included): a snapshot commit of every
 * untracked, non-ignored file alongside the tracked content. Absent outside a
 * git repository or when the snapshot failed — verification then runs without
 * baseline facts, flags, or a baseline worktree. Preserved on objective edit.
 */
export interface FermentV2Baseline {
	commit: string
	capturedAt: string
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
