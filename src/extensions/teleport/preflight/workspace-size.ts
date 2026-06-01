import { execFileSync } from "node:child_process"

export const SIZE_WARN_BYTES = 500_000_000
export const SIZE_REFUSE_BYTES = 5_000_000_000

export interface WorkspaceSizeOptions {
	execFile?: typeof execFileSync
}

export function estimateWorkspaceBytes(cwd: string, options?: WorkspaceSizeOptions): number {
	const execImpl = options?.execFile ?? execFileSync
	try {
		const stdout = execImpl("du", ["-sk", cwd], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		})
		const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10)
		return Number.isFinite(kb) ? kb * 1024 : 0
	} catch {
		return 0
	}
}
