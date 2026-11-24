import type { ResolvedReviewScope, ResolvedReviewTarget } from "../review-targets/types.js"

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
	signal?: AbortSignal
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
	/** Create or return the one checkout assigned to this stable identity. */
	getWorktree(id: string, options?: { kind?: ReviewCheckoutKind; revision?: ReviewRevision }): Promise<ReviewWorktree>
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
