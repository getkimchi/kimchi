/**
 * Standalone git worktree lifecycle for per-ferment isolation.
 *
 * These helpers have NO coupling to the ferment store — the scope-save creation
 * hook and the terminal-state cleanup hook call them directly. This keeps the
 * worktree mechanics independently testable.
 *
 * Worktree layout: `<repoRoot>/.worktrees/ferment-<shortId>` on branch
 * `ferment/<shortId>` branched from the current HEAD of `repoRoot`.
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export interface CreatedWorktree {
	/** Absolute path to the new worktree checkout. */
	path: string
	/** Branch name: `ferment/<shortId>`. */
	branch: string
	/** Commit SHA the branch was created from (repoRoot HEAD at creation time). */
	commit: string
}

export interface RemovalResult {
	/** True when both the worktree and branch were removed. */
	removed: boolean
	/** Human-readable reason on partial/full failure; undefined on full success. */
	reason?: string
}

const GIT_TIMEOUT = 10_000

/**
 * Run `git` with an argument array (no shell) and return trimmed stdout.
 * Throws on non-zero exit or spawn failure.
 */
function git(args: string[], opts: { cwd: string }): string {
	const result = spawnSync("git", args, {
		cwd: opts.cwd,
		encoding: "utf-8",
		timeout: GIT_TIMEOUT,
		shell: false,
		stdio: ["ignore", "pipe", "ignore"],
	})
	if (result.error) throw result.error
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} exited with ${result.status}: ${result.stderr?.trim() ?? ""}`)
	}
	return (result.stdout ?? "").trim()
}

/**
 * Whether `cwd` is inside a *linked* git worktree (i.e. a secondary checkout
 * created via `git worktree add`), as opposed to the main repository checkout.
 *
 * In the main checkout, `--git-dir` and `--git-common-dir` resolve to the same
 * `.git` path. In a linked worktree, `--git-dir` points at
 * `<main>/.git/worktrees/<name>` while `--git-common-dir` points at the shared
 * `<main>/.git`.
 */
export function isInsideLinkedWorktree(cwd: string = process.cwd()): boolean {
	try {
		const gitDir = git(["rev-parse", "--git-dir"], { cwd })
		const commonDir = git(["rev-parse", "--git-common-dir"], { cwd })
		if (!gitDir || !commonDir) return false
		// Resolve both to absolute, normalizing for relative output (".git" vs
		// an absolute path) so the comparison is stable.
		const absGitDir = resolve(cwd, gitDir)
		const absCommonDir = resolve(cwd, commonDir)
		return absGitDir !== absCommonDir
	} catch {
		// Not a git repo or git unavailable — cannot be inside a linked worktree.
		return false
	}
}

/**
 * Reject a `shortId` that could escape the intended `.worktrees/ferment-<shortId>`
 * path or branch namespace. Even though spawnSync arg arrays prevent shell
 * injection, a `shortId` containing `/` or `..` could traverse out of the
 * worktree directory, and other characters are invalid in git branch names.
 *
 * Allowed: alphanumeric, `-`, and `_` (the shape of a UUIDv7 prefix).
 */
const SAFE_SHORT_ID = /^[A-Za-z0-9_-]+$/

/**
 * Create a dedicated worktree for a ferment at
 * `<repoRoot>/.worktrees/ferment-<shortId>` on a new branch
 * `ferment/<shortId>` branched from the current HEAD of `repoRoot`.
 *
 * Throws on failure (e.g. the branch already exists, the path is taken, or git
 * is unavailable). Callers that want best-effort semantics should catch.
 */
export function createFermentWorktree(repoRoot: string, shortId: string): CreatedWorktree {
	if (!shortId || !SAFE_SHORT_ID.test(shortId)) {
		throw new Error(
			`Invalid shortId for ferment worktree: ${JSON.stringify(shortId)}. Only alphanumeric, '-', and '_' are allowed.`,
		)
	}
	const branch = `ferment/${shortId}`
	const path = resolve(repoRoot, ".worktrees", `ferment-${shortId}`)
	const commit = git(["rev-parse", "HEAD"], { cwd: repoRoot })
	// `git worktree add -b <branch> <path> <start-point>`
	git(["worktree", "add", "-b", branch, path, "HEAD"], { cwd: repoRoot })
	return { path, branch, commit }
}

/**
 * Best-effort removal of a ferment's worktree and its branch. Never throws:
 * on any failure it returns `{ removed: false, reason }` so terminal-state
 * cleanup can log a warning and leave the worktree intact rather than
 * destroying user work mid-transition.
 */
export function removeFermentWorktree(repoRoot: string, path: string, branch?: string): RemovalResult {
	const steps: string[] = []
	// 1. Remove the worktree checkout. Use --force only as a fallback so a
	//    dirty tree surfaces first (we prefer to leave it intact in that case).
	try {
		git(["worktree", "remove", path], { cwd: repoRoot })
	} catch {
		try {
			git(["worktree", "remove", "--force", path], { cwd: repoRoot })
		} catch (e) {
			steps.push(`worktree remove failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	// 2. Delete the branch (if any). Pruning the worktree above may already
	//    make the branch deletable with -d; fall back to -D for force-delete.
	if (branch) {
		try {
			git(["branch", "-d", branch], { cwd: repoRoot })
		} catch {
			try {
				git(["branch", "-D", branch], { cwd: repoRoot })
			} catch (e) {
				steps.push(`branch delete failed: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
	}
	if (steps.length === 0) return { removed: true }
	return { removed: false, reason: steps.join("; ") }
}
