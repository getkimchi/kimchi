import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type {
	ReviewAgentOptions,
	ReviewAgentSpawner,
	ReviewCheckDefinition,
	ReviewCommandRecord,
	ReviewExecutionPolicyOptions,
} from "../review-runner/index.js"
import type { ReviewCoverage, ReviewFindingRecord, ReviewSummaryRecord } from "../review-submit/store.js"
import type { ResolvedReviewScope, ResolvedReviewTarget } from "../review-targets/types.js"
import type { RequiredReviewLens, ReviewLensId, ReviewPanelArguments, ReviewPanelSelectionInput } from "./lenses.js"

export const REVIEW_PANEL_STATE_VERSION = "review-panel/v1"
export const REVIEW_RECONCILIATION_REQUEST_VERSION = "review-reconciliation-request/v1"
export const REVIEW_RECONCILIATION_VERSION = "review-reconciliation/v1"

export type ReviewLensStatus = "queued" | "running" | "submitted" | "failed" | "cancelled"
export type ReviewPanelPhase = "reviewing" | "reserve" | "reconciling" | "complete"

export interface ReviewPanelCandidate {
	id: string
	lens: ReviewLensId
	finding: ReviewFindingRecord
}

export interface ReviewLensRunState {
	id: ReviewLensId
	writer: string
	status: ReviewLensStatus
	reasons: string[]
	candidateIds: string[]
	error?: string
	worktreePath?: string
	commands?: ReviewCommandRecord[]
}

export interface ReconciliationDecision {
	candidate_id: string
	disposition: "retained" | "merged" | "rejected"
	/** Identity of the semantic finding for retained/merged candidates. */
	finding?: string
	reason: string
}

export interface ReconciliationFinding {
	id: string
	path: string
	line: number
	severity: "critical" | "warning" | "info"
	type: string
	description: string
	suggestion: string
	candidate_ids: string[]
}

export interface ReconciliationThread {
	thread_id: string
	body: string
	action: "resolve" | "reopen" | "none"
	verdict?: "fixed" | "not_fixed" | "partially_fixed" | "no_longer_applicable" | "regressed" | "unverified"
	evidence_kind?: "code_reference" | "existing_test" | "new_test" | "none"
	evidence?: string
	/** Current candidates equivalent to the earlier finding. They must be rejected in decisions. */
	equivalent_candidate_ids?: string[]
}

export interface SemanticReconciliation {
	schema_version: typeof REVIEW_RECONCILIATION_VERSION
	findings: ReconciliationFinding[]
	decisions: ReconciliationDecision[]
	threads: ReconciliationThread[]
}

export interface ReviewReconciliationState {
	status: "pending" | "fallback" | "reconciled"
	reason: string
	/** Digest of the ordered accepted candidates used for the current final checkpoint. */
	inputDigest?: string
	/** Digest of comments.json evaluated by this reconciliation, when present. */
	threadHistoryDigest?: string
	/** Complete source IDs per final finding; derived_from is capped only in the published file. */
	provenance?: Record<string, string[]>
	provenanceTruncatedCount?: number
	semantic?: SemanticReconciliation
}

export interface ReviewPanelRunState {
	schema_version: typeof REVIEW_PANEL_STATE_VERSION
	scope: ResolvedReviewScope
	contextDir: string
	outputDir: string
	panel: ReviewPanelArguments & {
		resolved: Array<{
			id: ReviewLensId
			writer: string
			focus: string
			reasons: string[]
		}>
		requestedConcurrency: number
		slotCount: number
		requiredLenses: RequiredReviewLens[]
	}
	lenses: ReviewLensRunState[]
	candidates: ReviewPanelCandidate[]
	reconciliation: ReviewReconciliationState
	coverage: ReviewCoverage
}

export interface ReviewPanelLensProgress {
	id: ReviewLensId
	writer: string
	status: ReviewLensStatus
	reasons: string[]
	candidateCount: number
	error?: string
}

export interface ReviewPanelProgress {
	phase: ReviewPanelPhase
	lenses: ReviewPanelLensProgress[]
	counts: Record<ReviewLensStatus, number> & { candidates: number }
	coverage: ReviewCoverage
	reconciliation: Pick<ReviewReconciliationState, "status" | "reason">
}

export interface ReviewPanelChildUsage {
	writer: string
	provider: string
	model: string
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
	parentToolCallId?: string
}

export interface ReviewPanelDroppedUsage extends ReviewPanelChildUsage {
	reason: "deadline"
}

export interface ReviewPanelModelOptions extends ReviewAgentOptions {
	model?: Model<Api>
}

export interface RunReviewPanelOptions extends ReviewPanelSelectionInput {
	ctx: ExtensionContext
	pi: ExtensionAPI
	target: ResolvedReviewTarget
	outputDir: string
	checkDefinitions?: ReviewCheckDefinition[]
	executionPolicy?: ReviewExecutionPolicyOptions
	/** Absolute epoch-millisecond deadline, parsed by stage 5 from the manifest's RFC 3339 timestamp. */
	deadline?: number
	signal?: AbortSignal
	onProgress?: (progress: ReviewPanelProgress) => void
	/** Buffered per child/provider/model; the supplied signal aborts on delivery timeout and closure. */
	onChildUsage?: (usage: ReviewPanelChildUsage, signal: AbortSignal) => void | Promise<void>
	/** Deltas not delivered by the final deadline margin; a pending callback is never awaited past it. */
	onUsageDropped?: (dropped: ReviewPanelDroppedUsage) => void
	parentToolCallId?: string
	agent?: ReviewPanelModelOptions
	reconciliationAgent?: ReviewPanelModelOptions
	/** Override only for a test-owned worktree parent. */
	rootDir?: string
	/** @internal Real ReviewRunner with a deterministic child-script seam used by offline tests. */
	spawnAgent?: ReviewAgentSpawner
	/** @internal Test timing override; production reserves two minutes. */
	reconciliationReserveMs?: number
	/** @internal Test timing override; production grants 30 seconds for submissions. */
	submitGraceMs?: number
	/** @internal Test timing override; production allows one second for post-cancel settlement. */
	cancellationGraceMs?: number
	/** Scheduling margin reserved for final artifacts and closure before deadline; default 5000 ms, non-negative. */
	finalWriteHeadroomMs?: number
}

export interface ReviewPanelIdentity {
	baseSha: string
	headSha: string
	checkoutPath: string
	contextDir: string
	outputDir: string
}

export interface WrapUpReviewPanelOptions {
	ctx: ExtensionContext
	pi: ExtensionAPI
	outputDir: string
	/** Stage 5 passes the new manifest identity. Deadline intentionally is not part of identity. */
	expected?: ReviewPanelIdentity
	checkDefinitions?: ReviewCheckDefinition[]
	executionPolicy?: ReviewExecutionPolicyOptions
	deadline?: number
	signal?: AbortSignal
	onProgress?: (progress: ReviewPanelProgress) => void
	onChildUsage?: (usage: ReviewPanelChildUsage, signal: AbortSignal) => void | Promise<void>
	onUsageDropped?: (dropped: ReviewPanelDroppedUsage) => void
	parentToolCallId?: string
	reconciliationAgent?: ReviewPanelModelOptions
	rootDir?: string
	/** @internal */ spawnAgent?: ReviewAgentSpawner
	/** @internal Test-only bound used while cancelling same-process abandoned children; production allows one second. */
	cancellationGraceMs?: number
	/** Scheduling margin reserved for final artifacts and closure before deadline; default 5000 ms, non-negative. */
	finalWriteHeadroomMs?: number
}

export interface ReviewPanelResult {
	state: ReviewPanelRunState
	progress: ReviewPanelProgress
	findings: ReviewFindingRecord[]
	summary: ReviewSummaryRecord
	findingsPath: string
	summaryPath: string
	repliesPath?: string
}

export type { ReviewCoverage, ReviewFindingRecord, ReviewPanelArguments, ReviewPanelSelectionInput }
