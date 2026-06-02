import { execSync } from "node:child_process"
import type { FermentUi } from "./ui.js"

/**
 * Check if `cwd` is inside a git repository (including subdirectories).
 * Uses `git rev-parse --is-inside-work-tree` which correctly handles subdirectories.
 */
function isInsideGitRepo(cwd: string): boolean {
	try {
		execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: ["ignore", "ignore", "ignore"] })
		return true
	} catch {
		return false
	}
}

export type EnsureGitRepoOutcome = "already-repo" | "initialized" | "declined" | "skipped" | "init-failed"

export interface EnsureGitRepoOptions {
	cwd?: string
	ui?: FermentUi
	/**
	 * When true, skip the interactive confirm and run `git init` unconditionally.
	 * Set by callers in non-interactive flows (e.g. one-shot with --init-git flag
	 * or KIMCHI_AUTO_GIT_INIT=1 env var).
	 */
	autoInit?: boolean
}

/**
 * Make sure the cwd is a git repo before a ferment is created.
 *
 *   - Already a repo  → no-op.
 *   - Interactive UI  → ask the user; init on yes, skip on no.
 *   - autoInit        → run `git init` without asking.
 *   - Otherwise       → skip silently (ferment still works, just without branch/commit).
 *
 * Returns the outcome so callers can surface a notification if they want to.
 */
export async function ensureGitRepo(opts: EnsureGitRepoOptions = {}): Promise<EnsureGitRepoOutcome> {
	const cwd = opts.cwd ?? process.cwd()
	if (isInsideGitRepo(cwd)) return "already-repo"

	if (!opts.autoInit) {
		if (typeof opts.ui?.confirm !== "function") return "skipped"
		const ok = await opts.ui.confirm(
			"Initialize git here?",
			`This directory (${cwd}) is not a git repository. Initialize one so the ferment can track branch and commit info?`,
		)
		if (!ok) return "declined"
	}

	try {
		execSync("git init", { cwd, stdio: ["ignore", "ignore", "ignore"], timeout: 5000 })
		opts.ui?.notify(`Initialized empty git repository in ${cwd}`)
		return "initialized"
	} catch (err) {
		opts.ui?.notify(`git init failed: ${err instanceof Error ? err.message : String(err)}`)
		return "init-failed"
	}
}

/** True if the user opted into auto-init via env var. */
export function autoInitFromEnv(): boolean {
	return process.env.KIMCHI_AUTO_GIT_INIT === "1"
}
