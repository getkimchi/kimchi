import { readdirSync, readFileSync, realpathSync } from "node:fs"
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

/** Canonicalize a path (resolve symlinks).
 *
 * IntelliJ's VFS returns real paths while the CLI's `cwd` and lockfile `workspaceFolders` may
 * be in symlink form — comparing across these without canonicalization produces broken results.
 *
 * Falls back to the original path if `realpathSync` fails (e.g. missing path, stale lockfile). */
export function realpathSafe(p: string): string {
	try {
		return realpathSync(p)
	} catch {
		return p
	}
}

/** Find the lockfile whose `workspaceFolders` contains cwd. Both sides are
 * canonicalized via `realpathSafe` so symlinked project roots match.
 * Returns `undefined` when no alive lockfile matches — the CLI will not
 * connect to an IDE whose workspace doesn't contain the current project. */
export function findMatchingLockfile(lockfiles: LockfileData[], cwd: string): LockfileData | undefined {
	const alive = lockfiles.filter((l) => isProcessAlive(l.pid))
	const cwdReal = realpathSafe(cwd).replace(/\\/g, "/")
	return alive.find((l) =>
		l.workspaceFolders.some((wf) => {
			const wfReal = realpathSafe(wf).replace(/\\/g, "/")
			return wfReal === cwdReal || cwdReal.startsWith(`${wfReal}/`)
		}),
	)
}
