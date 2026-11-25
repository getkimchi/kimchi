import type { ReviewPanelArguments } from "../review-panel/lenses.js"
import type { PreparedProviderReview } from "./provider.js"

export type ReviewPanelParseResult = ReviewPanelArguments

export const REVIEW_TARGET_SYNTAX = [
	"/review working-tree [--fetch]",
	"/review <branch> [--base <ref>] [--prefer local|remote] [--fetch]",
	"/review branch <ref> [--base <ref>] [--prefer local|remote] [--fetch]",
	"/review branch <ref> [--base <ref>] --include-working-tree [--fetch]",
	"/review <GitHub pull-request or GitLab merge-request URL> [--base <ref>]",
] as const

export interface BareReviewRequest {
	kind: "bare"
	fetch: boolean
	panel?: ReviewPanelArguments
}

export interface WorkingTreeReviewRequest {
	kind: "working-tree"
	fetch: boolean
	panel?: ReviewPanelArguments
}

export type ReviewBranchPreference = "local" | "remote"

export interface BranchReviewRequest {
	kind: "branch"
	branch: string
	base?: string
	includeWorkingTree: boolean
	fetch: boolean
	prefer?: ReviewBranchPreference
	panel?: ReviewPanelArguments
}

export interface ProviderReviewRequest {
	kind: "pull-request"
	url: string
	provider: "github" | "gitlab"
	host: string
	/** Repository path without a leading slash or .git suffix (nested groups retained). */
	project: string
	number: number
	base?: string
	fetch: boolean
	panel?: ReviewPanelArguments
}

export type ExplicitReviewRequest = WorkingTreeReviewRequest | BranchReviewRequest | ProviderReviewRequest
export type ParsedReviewRequest = BareReviewRequest | ExplicitReviewRequest

export interface ReviewBaseSuggestion {
	/** A local or remote-tracking ref that can be passed as --base. */
	ref: string
	/** The ref ultimately read after symbolic refs are followed. */
	resolvedRef?: string
	source: "pull-request-target" | "remote-default"
	remote?: string
}

export interface ReviewTargetChoice {
	kind: "working-tree" | "branch"
	available: boolean
	preselected: boolean
	/** Explains the target's unavailable state when available is false. */
	unavailableReason?: string
	baseSuggestion?: ReviewBaseSuggestion
	/** Branch can still be chosen, but its command must include --base. */
	requiresExplicitBase?: boolean
}

export type WorkingTreeStatus = "clean" | "edits" | "possible-edits"

export interface ReviewTargetChoices {
	choices: [ReviewTargetChoice, ReviewTargetChoice]
	syntax: typeof REVIEW_TARGET_SYNTAX
	workingTreeStatus: WorkingTreeStatus
	/** At most 20 paths; flaggedPathCount retains the total. */
	flaggedPaths: string[]
	flaggedPathCount: number
}

export interface ReviewInvocationOptions {
	/** Required session cwd for local use, or the explicit checkout path for headless use. */
	root: string
	/** Optional known PR/MR target branch. This never triggers provider discovery. */
	pullRequestTargetBranch?: string
	/** Select a configured remote when automatic selection would be ambiguous. */
	remote?: string
	/** Explicit Kimchi-owned directories to omit from working-tree snapshot discovery. */
	excludedDirectories?: readonly string[]
	signal?: AbortSignal
}

export interface ReviewBranchRevisionChoice {
	branch: string
	remote: string
	local: { ref: string; sha: string; ahead: number; behind: number }
	remoteRevision: { ref: string; sha: string }
}

export interface ReviewBaseChoice {
	branch: string
	candidates: ReviewBaseSuggestion[]
}

export interface ReviewTargetInteractions {
	chooseBranchRevision?: (choice: ReviewBranchRevisionChoice) => Promise<ReviewBranchPreference | undefined>
	/** Return a candidate ref, another ref entered by the user, or undefined to cancel. */
	chooseBase?: (choice: ReviewBaseChoice) => Promise<string | undefined>
}

export interface ResolveReviewTargetOptions extends ReviewInvocationOptions {
	contextDir?: string
	/** Present only on surfaces that can wait for a user decision. */
	interactions?: ReviewTargetInteractions
	/** Overrides the cache parent in tests; defaults to ~/.kimchi/review-repos. */
	cacheRoot?: string
	/** Reports a deterministic base selected without a prompt. */
	onBaseSelected?: (suggestion: ReviewBaseSuggestion) => void
	onWarning?: (message: string) => void
	/** Stop this review if proper-lockfile detects that its cache ownership was compromised. */
	onCacheCompromised?: (error: Error) => void
	/** Provider-owned commentable-lines/v1 data for exactly this base/head comparison. */
	providerAnchorMap?: unknown
	/** @internal Test-only cancellation injection before the checkout HEAD is resolved. */
	beforeHeadResolution?: () => void | Promise<void>
	/** @internal Test-only synchronization after the immutable provider head is fetched. */
	beforeProviderResolution?: (prepared: PreparedProviderReview) => void | Promise<void>
	/** @internal Test-only filesystem race injection after the working tree has been added to the temporary index. */
	beforeSnapshotCommit?: () => void | Promise<void>
}

export interface CommentableLineRange {
	start_line: number
	end_line: number
}

export interface CommentableFile {
	ranges?: CommentableLineRange[]
	reason?: string
}

export interface ProviderAnchorMap {
	schema_version: "commentable-lines/v1"
	commit_sha: string
	merge_base_sha: string
	files_cap_reached?: boolean
	files: Record<string, CommentableFile>
}

export interface ReviewLimitation {
	code:
		| "provider_anchor_map_unavailable"
		| "provider_anchor_map_mismatch"
		| "provider_anchor_map_rejected"
		| "provider_anchor_map_not_applicable"
	message: string
}

export interface ResolvedReviewScope {
	kind: "working-tree" | "branch"
	/** Ref spellings supplied by the user, plus the base selected by resolution. */
	refs: {
		branch?: string
		base?: string
		resolvedBase: string
		head: string
	}
	includeWorkingTree: boolean
	baseSource: "head" | "explicit" | "pull-request-target" | "remote-default"
	pinned: {
		baseSha: string
		headSha: string
		/** The selected commit before any working-tree snapshot is applied. */
		tipSha: string
		snapshotRef?: string
	}
	headKind: "commit" | "working-tree-snapshot"
	dirty: boolean
	files: {
		changed: number
		anchorable: number
		unanchorable: number
	}
	anchorSource: "local" | "provider"
	checkoutPath: string
	contextDir: string
	commentableLinesPath: string
	limitations: ReviewLimitation[]
	/** Provider presentation metadata; comparison and artifact formats are otherwise unchanged. */
	pullRequest?: {
		provider: "github" | "gitlab"
		url: string
		number: number
		title: string
		reportedHeadSha: string
		headMoved: boolean
	}
}

export interface ResolvedReviewTarget {
	scope: ResolvedReviewScope
	/** Resolved symbolic base for display only; scope retains the canonical ref. */
	baseDisplayRef?: string
	/** Delete only this resolution's private snapshot ref, if one was needed. */
	cleanup: () => Promise<void>
}

export interface CleanupReviewSnapshotOptions {
	root: string
	ref: string
	expectedHeadSha: string
	signal?: AbortSignal
}

export interface CleanupStaleReviewSnapshotsOptions {
	root: string
	olderThanMs: number
	signal?: AbortSignal
}

export interface RemovedReviewSnapshot {
	ref: string
	headSha: string
}

export class ReviewTargetError extends Error {
	override readonly name = "ReviewTargetError"

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}
