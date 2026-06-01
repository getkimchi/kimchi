import { execFileSync } from "node:child_process"

export interface RsyncPreflightOptions {
	execFile?: typeof execFileSync
	platform?: NodeJS.Platform
}

export function whichRsync(options?: RsyncPreflightOptions): boolean {
	const execImpl = options?.execFile ?? execFileSync
	try {
		execImpl("which", ["rsync"], { stdio: "ignore", timeout: 5_000 })
		return true
	} catch {
		return false
	}
}

export function rsyncInstallHint(options?: RsyncPreflightOptions): string {
	const platform = options?.platform ?? process.platform
	if (platform === "darwin") return "Install with: brew install rsync"
	if (platform === "linux") return "Install with your package manager (e.g. apt install rsync)"
	return "Install rsync and ensure it is on PATH"
}
