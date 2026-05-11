/**
 * Worktree validation: confirm the user is in the directory and on the branch
 * that the ferment was created against.
 */

import { execSync } from "node:child_process"
import type { Ferment } from "../../ferment/types.js"

export interface WorktreeCheck {
	severity: "ok" | "warn" | "block"
	message?: string
}

export function checkWorktree(f: Ferment): WorktreeCheck {
	const cwd = process.cwd()
	// Path containment: cwd must equal worktree.path OR start with worktree.path + "/".
	// String prefix alone gives a false positive for "/foo/projectextra" vs "/foo/project".
	const wtPath = f.worktree.path
	const isInside = cwd === wtPath || cwd.startsWith(`${wtPath}/`)
	if (!isInside) {
		return {
			severity: "block",
			message: `You are in ${cwd}, but this ferment was created in ${wtPath}. Use /ferment switch to activate a different ferment, or /ferment switch --force to override.`,
		}
	}
	if (f.worktree.branch) {
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
