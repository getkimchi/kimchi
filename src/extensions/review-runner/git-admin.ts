import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { gitText } from "../review-targets/git.js"
import type { ReviewWorktree } from "./types.js"

function canonicalOwnedGitAdminDirectory(
	worktreePath: string,
	adminCandidate: string,
	commonCandidate: string,
): string {
	const adminDir = realpathSync(adminCandidate)
	const commonDir = realpathSync(commonCandidate)
	const commonWorktrees = realpathSync(join(commonDir, "worktrees"))
	if (dirname(adminDir) !== commonWorktrees) {
		throw new Error(`Reviewer Git admin directory ${adminDir} must be a direct child of ${commonWorktrees}.`)
	}
	const backLink = readFileSync(join(adminDir, "gitdir"), "utf8").trimEnd()
	const linkedCheckoutGitFile = realpathSync(resolve(adminDir, backLink))
	const checkoutGitFile = realpathSync(join(worktreePath, ".git"))
	if (linkedCheckoutGitFile !== checkoutGitFile) {
		throw new Error(`Reviewer Git admin directory ${adminDir} does not belong to checkout ${worktreePath}.`)
	}
	return adminDir
}

/** Capture the assigned admin directory immediately after trusted `git worktree add`,
 * before any reviewer-controlled command can change the checkout. */
export async function captureReviewWorktreeGitAdmin(worktreePath: string, signal?: AbortSignal): Promise<string> {
	const output = await gitText(worktreePath, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
		signal,
	})
	const paths = output.trim().split("\n")
	if (paths.length !== 2 || !paths[0] || !paths[1]) {
		throw new Error(`Could not determine the assigned Git admin directory for reviewer checkout ${worktreePath}.`)
	}
	return canonicalOwnedGitAdminDirectory(worktreePath, resolve(worktreePath, paths[0]), resolve(worktreePath, paths[1]))
}

/** Revalidate only the immutable creation-time assignment. A missing or mismatched
 * assignment drops the exception; the checkout never selects an admin directory. */
export function validatedReviewWorktreeGitAdmin(
	worktree: Pick<ReviewWorktree, "path" | "gitAdminDir">,
): string | undefined {
	if (!worktree.gitAdminDir) return undefined
	try {
		return canonicalOwnedGitAdminDirectory(
			worktree.path,
			worktree.gitAdminDir,
			resolve(worktree.gitAdminDir, "..", ".."),
		)
	} catch {
		return undefined
	}
}
