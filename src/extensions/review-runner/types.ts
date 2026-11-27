import type { ResolvedReviewScope, ResolvedReviewTarget } from "../review-targets/types.js"
import type { ReviewEnvironmentGap, ReviewEnvironmentReceipt, ReviewEnvironmentSettings } from "./environment.js"
import type { ReviewExecutionPolicyOptions } from "./execution.js"

export type ReviewRevision = "base" | "head"
export type ReviewCheckoutKind = "reviewer" | "checks" | "verifier"

export interface ReviewWorktreeOptions {
	/** Stage 2's resolved target. Its snapshot ref is released only after pool cleanup. */
	target: ResolvedReviewTarget
	/** Parent for this run's private directory. Defaults to the system temporary directory. */
	rootDir?: string
	/** Stage 1 output directory; worktrees and scratch state must remain outside it. */
	outputDir: string
	/** Maximum concurrently leased reviewers. Check execution has its own queue. */
	concurrency?: number
	/** Trusted invoking-session catalog/profile; omitted means legacy isolation. */
	environment?: ReviewEnvironmentSettings
	environmentGaps?: readonly ReviewEnvironmentGap[]
	executionPolicy?: ReviewExecutionPolicyOptions
	signal?: AbortSignal
	/** @internal Test-only lower bound for the overall 300-second preparation cap. */
	preparationTimeoutMs?: number
	/** @internal Crash-point hook used by the real-process recovery fixture. */
	worktreeCrashPoint?: (
		point: "before-add" | "after-add",
		details: { path: string; runDir: string },
	) => void | Promise<void>
}

export interface ReviewWorktree {
	id: string
	kind: ReviewCheckoutKind
	revision: ReviewRevision
	path: string
	pinnedSha: string
	scratchDir: string
	buildDir: string
	cacheDir: string
	homeDir: string
	/** Canonical per-worktree Git admin path captured at trusted creation. Boundaries
	 * omit this exception when it is absent or fails canonical ownership checks. */
	readonly gitAdminDir?: string
	/** Canonical cache paths exposed read-only by enforceable local boundaries. */
	readOnlyCachePaths?: readonly string[]
	/** Actual preparation receipt. Optional only for lightweight external fixtures;
	 * every pool-created worktree has one before it becomes ready. */
	environment?: ReviewEnvironmentReceipt
	/** Per-process cache and temporary-directory settings shared by child commands. */
	env: Record<string, string>
}

export interface ReviewWorktreeLease {
	worktree: ReviewWorktree
	release: () => void
}

export interface ReviewWorktreePool {
	readonly scope: ResolvedReviewScope
	readonly runDir: string
	readonly environmentReceipts: readonly ReviewEnvironmentReceipt[]
	readonly environmentGaps: readonly ReviewEnvironmentGap[]
	/** Create or return the one checkout assigned to this stable identity. The
	 * per-caller signal is combined with the pool's preparation cancellation. */
	getWorktree(
		id: string,
		options?: { kind?: ReviewCheckoutKind; revision?: ReviewRevision; signal?: AbortSignal },
	): Promise<ReviewWorktree>
	/** Return an already ready checkout without materializing one during wrap-up. */
	existingWorktree(
		id: string,
		options?: { kind?: ReviewCheckoutKind; revision?: ReviewRevision },
	): ReviewWorktree | undefined
	/** Lease a reviewer checkout. Distinct leases are bounded by the configured concurrency. */
	leaseReviewer(id: string, options?: { signal?: AbortSignal }): Promise<ReviewWorktreeLease>
	/** Remove every checkout, prune Git metadata, release scratch, then release stage 2's snapshot. */
	cleanup: () => Promise<void>
}

export interface RecoveredReviewWorktrees {
	runDir: string
	repository: string
	removedWorktrees: string[]
	releasedSnapshotRef?: string
}

export interface RecoverReviewWorktreesOptions {
	/** Parent containing run directories. Only this library's manifest-owned directories are inspected. */
	rootDir?: string
	olderThanMs: number
	signal?: AbortSignal
}
