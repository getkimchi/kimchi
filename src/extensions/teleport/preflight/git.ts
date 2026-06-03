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
	const execImpl = options?.execFile ?? execFileSync
	try {
		const stdout = execImpl("git", ["-C", cwd, "remote", "get-url", "origin"], {
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
