import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { FALLBACK_TARGET_NAME, SANDBOX_HOME } from "./types.js"

const execAsync = promisify(exec)

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms)
		if (signal) {
			const onAbort = () => {
				clearTimeout(t)
				reject(new Error("aborted"))
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
		}
	})
}

export async function waitUntilIdle(check: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (check()) return true
		try {
			await sleep(100, signal)
		} catch {
			return check()
		}
	}
	return check()
}

export function isBusy(session: AgentSession): boolean {
	if ((session as { isStreaming?: boolean }).isStreaming) return true
	if ((session as { isBashRunning?: boolean }).isBashRunning) return true
	if ((session as { hasPendingBashMessages?: boolean }).hasPendingBashMessages) return true
	return false
}

export async function whichRsync(): Promise<boolean> {
	try {
		await execAsync("command -v rsync")
		return true
	} catch {
		return false
	}
}

export async function estimateWorkspaceBytes(cwd: string): Promise<number> {
	try {
		const { stdout } = await execAsync(`du -sk "${cwd}"`, { maxBuffer: 1024 * 1024 })
		const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10)
		return Number.isFinite(kb) ? kb * 1024 : 0
	} catch {
		return 0
	}
}

export async function gitWorkingTreeDirty(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" status --porcelain`)
		return stdout.trim().length > 0
	} catch {
		return false
	}
}

export function rsyncInstallHint(): string {
	if (process.platform === "darwin") return "Install with: brew install rsync"
	if (process.platform === "linux") return "Install with your package manager (e.g. apt install rsync)"
	return "Install rsync and ensure it is on PATH"
}

export function deriveSandboxDest(localCwd: string): string {
	const { basename } = require("node:path")
	const trimmed = localCwd.replace(/\/+$/, "")
	const raw = basename(trimmed)
	const cleaned = raw.replace(/[/\0]/g, "_")
	const name = cleaned.length > 0 && cleaned !== "." ? cleaned : FALLBACK_TARGET_NAME
	return `${SANDBOX_HOME}/${name}/`
}
