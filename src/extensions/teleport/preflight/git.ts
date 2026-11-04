// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export interface GitPreflightOptions {
	execFile?: typeof execFileSync
}

export function isGitRepo(cwd: string): boolean {
	return existsSync(join(cwd, ".git"))
}

export function gitWorkingTreeDirty(cwd: string, options?: GitPreflightOptions): boolean {
	const execImpl = options?.execFile ?? execFileSync
	try {
		const stdout = execImpl("git", ["-C", cwd, "status", "--porcelain"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		})
		return stdout.trim().length > 0
	} catch {
		return false
	}
}

export function getGitRemoteUrl(cwd: string, options?: GitPreflightOptions): string | undefined {
	return runGit(cwd, ["remote", "get-url", "origin"], options)
}

export function getGitHeadSha(cwd: string, options?: GitPreflightOptions): string | undefined {
	return runGit(cwd, ["rev-parse", "--short", "HEAD"], options)
}

function runGit(cwd: string, args: string[], options?: GitPreflightOptions): string | undefined {
	const execImpl = options?.execFile ?? execFileSync
	try {
		const stdout = execImpl("git", ["-C", cwd, ...args], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		})
		const trimmed = stdout.trim()
		return trimmed.length > 0 ? trimmed : undefined
	} catch {
		return undefined
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
