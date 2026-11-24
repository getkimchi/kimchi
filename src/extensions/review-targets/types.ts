export const REVIEW_TARGET_SYNTAX = [
	"/review working-tree [--fetch]",
	"/review branch <ref> --base <ref> [--fetch]",
	"/review branch <ref> --base <ref> --include-working-tree [--fetch]",
] as const

export interface BareReviewRequest {
	kind: "bare"
	fetch: boolean
}

export interface WorkingTreeReviewRequest {
	kind: "working-tree"
	fetch: boolean
}

export interface BranchReviewRequest {
	kind: "branch"
	branch: string
	base?: string
	includeWorkingTree: boolean
	fetch: boolean
}

export type ExplicitReviewRequest = WorkingTreeReviewRequest | BranchReviewRequest
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
	preselected: boolean
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
	signal?: AbortSignal
}

export interface ResolveReviewTargetOptions extends ReviewInvocationOptions {
	contextDir?: string
	/** Provider-owned commentable-lines/v1 data for exactly this base/head comparison. */
	providerAnchorMap?: unknown
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
}

export interface ResolvedReviewTarget {
	scope: ResolvedReviewScope
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
