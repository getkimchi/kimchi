import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LockfileData } from "./types.js"

const DEFAULT_LOCKFILE_DIR = join(homedir(), ".config", "kimchi", "ide")

export function getLockfileDir(): string {
	return process.env.KIMCHI_IDE_LOCKFILE_DIR ?? DEFAULT_LOCKFILE_DIR
}

/** Return all absolute paths to *.lock files in the lockfile directory. */
export function scanLockfiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".lock"))
			.map((f) => join(dir, f))
	} catch {
		return []
	}
}

/** Parse a single lockfile. Returns `null` if malformed or missing required fields. */
export function parseLockfile(path: string): LockfileData | null {
	let raw: string
	try {
		raw = readFileSync(path, "utf-8")
	} catch {
		return null
	}

	let data: unknown
	try {
		data = JSON.parse(raw)
	} catch {
		return null
	}

	if (typeof data !== "object" || data === null) return null

	const d = data as Record<string, unknown>
	if (typeof d.port !== "number") return null
	if (typeof d.pid !== "number") return null
	if (typeof d.authToken !== "string") return null
	if (!Array.isArray(d.workspaceFolders)) return null

	return {
		port: d.port,
		pid: d.pid,
		ideName: typeof d.ideName === "string" ? d.ideName : "unknown",
		ideVersion: typeof d.ideVersion === "string" ? d.ideVersion : "unknown",
		transport: typeof d.transport === "string" ? d.transport : "ws",
		workspaceFolders: d.workspaceFolders.filter((f): f is string => typeof f === "string"),
		authToken: d.authToken,
	}
}

/** Best-effort check whether a process with the given PID is still running. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Find a lockfile whose workspaceFolders contains the given cwd.
 *
 * Falls back to any alive lockfile when none matches the cwd.
 */
export function findMatchingLockfile(lockfiles: LockfileData[], cwd: string): LockfileData | undefined {
	const alive = lockfiles.filter((l) => isProcessAlive(l.pid))
	const exactMatch = alive.find((l) =>
		l.workspaceFolders.some((wf) => {
			const normalized = wf.replace(/\\/g, "/")
			const cwdNormalized = cwd.replace(/\\/g, "/")
			return normalized === cwdNormalized || cwdNormalized.startsWith(`${normalized}/`)
		}),
	)
	return exactMatch ?? alive[0]
}
