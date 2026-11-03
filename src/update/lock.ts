// The updater lock — the machine-wide exclusion that lets only one session
// install at a time (see GLOSSARY.md, docs/adr/0001-background-auto-update.md).
// A session that finds the lock held skips its update tick; the winner's
// in-place install covers everyone. Because installs are global, skipping is
// always safe — the loser retries on its own cadence or simply launches later.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { statePath } from "./paths.js"

/** Locks older than this are treated as stale regardless of the recorded
 *  PID: after a kill -9 mid-install, the OS can recycle the owner's PID
 *  into any long-lived process and `kill(pid, 0)` would falsely report the
 *  lock as held forever. 15 minutes is far longer than any install. */
export const LOCK_STALE_MS = 15 * 60_000

export interface UpdaterLock {
	/** Free the lock. Best-effort: a failed removal (already taken over by
	 *  another process after we were killed and restarted) is ignored. */
	release(): void
}

export interface AcquireOptions {
	/** Lock file path; defaults next to state.json (~/.cache/kimchi/). */
	lockPath?: string
	/** Aliveness probe for the recorded PID; injectable so tests can simulate
	 *  dead and foreign owners. */
	isPidAlive?: (pid: number) => boolean
	/** Clock injection for staleness tests. */
	now?: () => number
}

/** Default probe: signal 0 checks existence without delivering a signal.
 *  EPERM means the process exists but belongs to another user — still alive. */
function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM"
	}
}

interface LockContents {
	pid: number
	/** Epoch ms when the lock was taken; the staleness escape hatch. */
	at?: number
}

function readLock(lockPath: string): LockContents | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf-8"))
		if (parsed && typeof parsed === "object") {
			const pid = (parsed as { pid?: unknown }).pid
			if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
				const at = (parsed as { at?: unknown }).at
				return { pid, at: typeof at === "number" ? at : undefined }
			}
		}
	} catch {
		// Missing or unparseable — treated as an abandoned lock.
	}
	return null
}

/**
 * Try to take the updater lock. Returns a handle when acquired, null when
 * another live session holds it. A lock whose owner is dead — or whose
 * contents are unparseable — is taken over: the stale file is removed and the
 * create is retried once. If two sessions race for the takeover, the O_EXCL
 * create decides; the loser gets null.
 *
 * Never throws: a broken filesystem must not stop the calling tick from
 * launching normally (callers treat null as "skip this tick" anyway).
 */
export function acquireUpdaterLock(opts: AcquireOptions = {}): UpdaterLock | null {
	const lockPath = opts.lockPath ?? defaultLockPath()
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive
	const now = opts.now ?? Date.now

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
			// O_EXCL: fails when the file exists, atomically reserving it when
			// it does not — the only atomic primitive available across processes.
			writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: now() }), { flag: "wx", mode: 0o600 })
			return { release: () => releaseLock(lockPath) }
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null
			const contents = readLock(lockPath)
			const held =
				contents !== null &&
				isPidAlive(contents.pid) &&
				contents.at !== undefined &&
				now() - contents.at < LOCK_STALE_MS
			if (held) return null
			// Stale (dead owner), corrupt, or aged out: remove and retry once.
			try {
				rmSync(lockPath, { force: true })
			} catch {
				return null
			}
		}
	}
	return null
}

function releaseLock(lockPath: string): void {
	try {
		rmSync(lockPath, { force: true })
	} catch {
		// Best-effort.
	}
}

function defaultLockPath(): string {
	// state.json lives at <cache>/kimchi/state.json; the lock sits beside it.
	return join(dirname(statePath()), "updater.lock")
}
