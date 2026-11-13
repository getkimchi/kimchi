/**
 * Restart-in-place handoff for EnterWorktree/ExitWorktree (slice 4).
 *
 * The TUI tools can't re-exec themselves — they run inside pi's interactive
 * loop. Instead they request a graceful shutdown (ctx.shutdown() only sets a
 * flag checked at the next turn boundary) after writing this marker; cli.ts
 * reads it after pi's main() returns and re-execs the same binary with the
 * resume args. The exit direction also needs a launch cwd (the worktree's
 * main checkout), passed via KIMCHI_WORKTREE_LAUNCH_CWD and consumed by
 * cli.ts before the pre-main `--worktree` handling.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Env var carrying the desired launch cwd for the re-exec'd process. */
export const KIMCHI_WORKTREE_LAUNCH_CWD_ENV = "KIMCHI_WORKTREE_LAUNCH_CWD"

const RESTART_FILE = "worktree-restart.json"

export interface WorktreeRestartRequest {
	/** enter → re-exec with `--worktree <name>`; exit → re-exec from mainRoot. */
	direction: "enter" | "exit"
	/** Worktree name (enter only). */
	name?: string
	/** Main checkout root (exit only — becomes the new launch cwd). */
	mainRoot?: string
	/** Session file to resume after the restart. */
	sessionFile: string
}

function restartPath(agentDir: string): string {
	return join(agentDir, RESTART_FILE)
}

export function writeWorktreeRestartRequest(agentDir: string, request: WorktreeRestartRequest): void {
	writeFileSync(restartPath(agentDir), JSON.stringify(request), "utf-8")
}

/** Read the pending restart request, or undefined when none is pending or the
 *  file is unreadable/malformed (a stale marker must never break a launch). */
export function readWorktreeRestartRequest(agentDir: string): WorktreeRestartRequest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(restartPath(agentDir), "utf-8"))
		if (typeof parsed !== "object" || parsed === null) return undefined
		const direction = (parsed as { direction?: unknown }).direction
		const sessionFile = (parsed as { sessionFile?: unknown }).sessionFile
		if (direction !== "enter" && direction !== "exit") return undefined
		if (typeof sessionFile !== "string" || !sessionFile) return undefined
		const name = (parsed as { name?: unknown }).name
		const mainRoot = (parsed as { mainRoot?: unknown }).mainRoot
		return {
			direction,
			sessionFile,
			name: typeof name === "string" && name ? name : undefined,
			mainRoot: typeof mainRoot === "string" && mainRoot ? mainRoot : undefined,
		}
	} catch {
		return undefined
	}
}

export function clearWorktreeRestartRequest(agentDir: string): void {
	try {
		unlinkSync(restartPath(agentDir))
	} catch {
		// Already gone — fine.
	}
}
