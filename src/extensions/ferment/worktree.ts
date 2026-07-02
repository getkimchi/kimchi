/**
 * Worktree validation and activation: confirm the agent is inside the ferment's
 * worktree, and switch the process cwd into a dedicated per-ferment worktree
 * when one exists.
 */

import { execSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { Ferment, FermentWorktree } from "../../ferment/types.js"

export interface WorktreeCheck {
	severity: "ok" | "warn" | "block"
	message?: string
}

/**
 * Whether a ferment is using a dedicated git worktree created for isolation.
 * Detected by path (`.worktrees/ferment-<shortId>`) or branch (`ferment/<id>`).
 */
export function isDedicatedWorktree(worktree: FermentWorktree): boolean {
	if (!worktree?.path) return false
	const normalized = resolve(worktree.path)
	if (normalized.includes(`${sep}.worktrees${sep}ferment-`)) return true
	if (worktree.branch?.startsWith("ferment/")) return true
	return false
}

function normalizePath(p: string): string {
	try {
		return realpathSync(p)
	} catch {
		return resolve(p)
	}
}

/**
 * Robust path containment check. Returns true when `child` is equal to `parent`
 * or is located inside `parent`. Both paths are normalized via `resolve()` and,
 * where possible, `realpathSync()` so symlinks (e.g. macOS `/var` → `/private/var`)
 * do not cause false negatives. Segment-aware comparison prevents string-prefix
 * tricks like `/foo/projectextra` vs `/foo/project`.
 */
export function pathStartsWith(parent: string, child: string): boolean {
	const rParent = normalizePath(parent)
	const rChild = normalizePath(child)
	if (rParent === rChild) return true
	const prefix = `${rParent}${sep}`
	return rChild.startsWith(prefix)
}

/**
 * Switch `process.cwd()` into the ferment's dedicated worktree when one exists.
 * Returns true when the cwd was changed. This is a no-op for legacy ferments
 * that only record the main repository checkout, and when the cwd is already
 * inside the dedicated worktree.
 */
export function maybeSwitchToFermentWorktree(f: Ferment | undefined): boolean {
	if (!f || !isDedicatedWorktree(f.worktree)) return false
	const target = normalizePath(f.worktree.path)
	if (pathStartsWith(target, process.cwd())) return false
	process.chdir(target)
	return true
}

export function checkWorktree(f: Ferment): WorktreeCheck {
	const cwd = process.cwd()
	const wtPath = f.worktree.path
	if (!pathStartsWith(wtPath, cwd)) {
		return {
			severity: "block",
			message: `You are in ${cwd}, but this ferment was created in ${wtPath}. Use /ferment switch to activate a different ferment, or /ferment switch --force to override.`,
		}
	}
	// Branch-mismatch warnings are only meaningful for the main checkout.
	// Dedicated worktrees are on their own ferment/* branch by design, and the
	// agent's cwd is already switched into them on activation.
	if (!isDedicatedWorktree(f.worktree) && f.worktree.branch) {
		try {
			const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: f.worktree.path,
				encoding: "utf-8",
				timeout: 1000,
			}).trim()
			if (currentBranch !== f.worktree.branch) {
				return {
					severity: "warn",
					message: `⚠️  You're on branch '${currentBranch}', but this ferment was started on '${f.worktree.branch}'. Use /ferment switch --force to override.`,
				}
			}
		} catch {
			// not a git repo or git unavailable
		}
	}
	return { severity: "ok" }
}
