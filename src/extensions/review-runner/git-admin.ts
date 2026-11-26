import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { gitBytes } from "../review-targets/git.js"
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

async function absoluteGitPath(
	worktreePath: string,
	query: "--git-dir" | "--git-common-dir",
	signal?: AbortSignal,
): Promise<string> {
	const result = await gitBytes(worktreePath, ["rev-parse", "--path-format=absolute", query], { signal })
	const output = result.stdout.toString("utf8")
	return output.endsWith("\n") ? output.slice(0, -1) : output
}

/** Capture the assigned admin directory immediately after trusted `git worktree add`,
 * before any reviewer-controlled command can change the checkout. */
export async function captureReviewWorktreeGitAdmin(worktreePath: string, signal?: AbortSignal): Promise<string> {
	const adminPath = await absoluteGitPath(worktreePath, "--git-dir", signal)
	const commonPath = await absoluteGitPath(worktreePath, "--git-common-dir", signal)
	if (!adminPath || !commonPath) {
		throw new Error(`Could not determine the assigned Git admin directory for reviewer checkout ${worktreePath}.`)
	}
	return canonicalOwnedGitAdminDirectory(
		worktreePath,
		resolve(worktreePath, adminPath),
		resolve(worktreePath, commonPath),
	)
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
