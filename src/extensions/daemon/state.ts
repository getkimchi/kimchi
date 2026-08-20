/**
 * Daemon state directory.
 *
 * Daemons are detached processes that intentionally outlive the kimchi
 * session (see `spec-daemon-tool-2026-08-20.md`). Because they survive the
 * session, their bookkeeping can NOT live in the session-scoped
 * ProcessRegistry (`src/extensions/bash-background/process-registry.ts`) —
 * that is drained on `session_shutdown`. Instead each daemon gets a small
 * JSON record on disk under `~/.config/kimchi/daemons/` (matching the
 * config/store convention in `src/config.ts`):
 *
 *   <id>.json   — { id, pid, command, cwd, startedAt, logFile, pidFile }
 *   <id>.log    — daemon stdout+stderr (shell-redirected at spawn)
 *   <id>.pid    — pid as text (for humans/debugging; .json is authoritative)
 *
 * Records are validated on read (malformed files are skipped, not thrown)
 * and `list` liveness-prunes entries whose pid is gone, so the directory
 * is self-healing after reboots where pids get reused.
 */

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface DaemonRecord {
	id: string
	pid: number
	command: string
	cwd: string
	name?: string
	startedAt: string
	logFile: string
	pidFile: string
}

/** Root of the daemon state directory. Overridable for tests. */
export function daemonStateDir(): string {
	return join(homedir(), ".config", "kimchi", "daemons")
}

export function ensureStateDir(dir: string): void {
	mkdirSync(dir, { recursive: true })
}

/**
 * Validate a user-supplied daemon name. Only alphanumerics, dash, and
 * underscore — the name is interpolated into a filename, so path
 * separators or dots could escape the state dir (review-lessons rule 4).
 * Empty string is INVALID — callers wanting "no name" must pass
 * `undefined` (an explicit empty name would silently fall through to the
 * default prefix and produce confusing `-a1b2c3`-style ids).
 */
export function validateDaemonName(name: string): string | undefined {
	if (name.length === 0) return "Daemon name cannot be empty (omit the parameter for the default name)."
	if (name.length > 40) return "Daemon name too long (max 40 chars)."
	if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
		return "Daemon name may only contain letters, digits, dash, and underscore."
	}
	return undefined
}

/** Generate a daemon id: <name|daemon>-<6 hex chars>. */
export function makeDaemonId(name: string | undefined): string {
	const suffix = randomBytes(3).toString("hex")
	return `${name ? name : "daemon"}-${suffix}`
}

export function daemonRecordPath(dir: string, id: string): string {
	return join(dir, `${id}.json`)
}

export function registerDaemon(dir: string, record: DaemonRecord): void {
	ensureStateDir(dir)
	writeFileSync(daemonRecordPath(dir, record.id), JSON.stringify(record, null, 2))
	writeFileSync(record.pidFile, String(record.pid))
}

export function unregisterDaemon(dir: string, id: string): void {
	rmSync(daemonRecordPath(dir, id), { force: true })
	rmSync(join(dir, `${id}.pid`), { force: true })
}

/** Runtime-validated record read; undefined when missing or malformed. */
export function readDaemon(dir: string, id: string): DaemonRecord | undefined {
	const path = daemonRecordPath(dir, id)
	if (!existsSync(path)) return undefined
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, "utf8"))
	} catch (err) {
		console.error(`daemon state: malformed record ${id}:`, err)
		return undefined
	}
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	if (
		typeof r.id !== "string" ||
		typeof r.pid !== "number" ||
		typeof r.command !== "string" ||
		typeof r.logFile !== "string" ||
		typeof r.pidFile !== "string" ||
		typeof r.startedAt !== "string"
	) {
		console.error(`daemon state: record ${id} missing required fields`)
		return undefined
	}
	return {
		id: r.id,
		pid: r.pid,
		command: r.command,
		cwd: typeof r.cwd === "string" ? r.cwd : "",
		name: typeof r.name === "string" ? r.name : undefined,
		startedAt: r.startedAt,
		logFile: r.logFile,
		pidFile: r.pidFile,
	}
}

/** True when the pid exists (kill(pid, 0) is existence-check only). */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err: unknown) {
		// EPERM means the process exists but is owned by someone else — alive.
		if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "EPERM") {
			return true
		}
		return false
	}
}

export interface DaemonListEntry {
	record: DaemonRecord
	alive: boolean
}

/**
 * List all recorded daemons with liveness. Dead entries are pruned from
 * the state dir (records AND pid files) so a reboot's pid reuse doesn't
 * leave phantom daemons around.
 */
export function listDaemons(dir: string): DaemonListEntry[] {
	if (!existsSync(dir)) return []
	const out: DaemonListEntry[] = []
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue
		const record = readDaemon(dir, file.slice(0, -".json".length))
		if (!record) continue
		const alive = isPidAlive(record.pid)
		if (!alive) {
			unregisterDaemon(dir, record.id)
			continue
		}
		out.push({ record, alive })
	}
	return out
}
