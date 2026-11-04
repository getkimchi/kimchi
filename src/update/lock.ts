// The updater lock — the machine-wide exclusion that lets only one session
// install at a time (see docs/auto-update.md).
// A session that finds the lock held skips its update tick; the winner's
// in-place install covers everyone. Because installs are global, skipping is
// always safe — the loser retries on its own cadence or simply launches later.

import { randomUUID } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { statePath } from "./paths.js"

/** Locks older than this are treated as stale regardless of the recorded
 *  PID: after a kill -9 mid-install, the OS can recycle the owner's PID
 *  into any long-lived process and `kill(pid, 0)` would falsely report the
 *  lock as held forever. 15 minutes is far longer than any install. */
export const LOCK_STALE_MS = 15 * 60_000

/** How often the holder refreshes the lock's timestamp. A long-running
 *  install (slow download, an interactive `kimchi update` prompt) would
 *  otherwise cross LOCK_STALE_MS and invite a takeover; a third of the
 *  staleness window leaves two missed beats before the escape can fire. */
export const LOCK_HEARTBEAT_MS = LOCK_STALE_MS / 3

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
	/** Heartbeat interval; ≤0 disables it. */
	heartbeatMs?: number
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
	/** Random per-holder token; release only deletes its own lock, so a
	 *  holder whose lock was stolen (staleness takeover) cannot delete the
	 *  usurper's. The PID alone is not enough: it can be recycled. */
	nonce?: string
}

function readLock(lockPath: string): LockContents | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf-8"))
		if (parsed && typeof parsed === "object") {
			const pid = (parsed as { pid?: unknown }).pid
			if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
				const at = (parsed as { at?: unknown }).at
				const nonce = (parsed as { nonce?: unknown }).nonce
				return {
					pid,
					at: typeof at === "number" ? at : undefined,
					nonce: typeof nonce === "string" ? nonce : undefined,
				}
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
 *
 * Note: killing a session mid-acquire can strand an `*.tmp` file in the
 * cache dir; callers ignore it (it is never linked into place).
 */
export function acquireUpdaterLock(opts: AcquireOptions = {}): UpdaterLock | null {
	const lockPath = opts.lockPath ?? defaultLockPath()
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive
	const now = opts.now ?? Date.now

	const heartbeatMs = opts.heartbeatMs ?? LOCK_HEARTBEAT_MS

	const tmpPath = `${lockPath}.${process.pid}.tmp`
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
			// Publish atomically: a bare create-then-write would leave an empty
			// or truncated file a rival could read as an abandoned lock. Write a
			// temp file, then hard-link it into place — link fails with EEXIST
			// when the target exists, which is the same atomic O_EXCL guarantee
			// but the file never appears half-written.
			const owner: LockContents = { pid: process.pid, at: now(), nonce: randomUUID() }
			writeFileSync(tmpPath, JSON.stringify(owner), { mode: 0o600 })
			linkSync(tmpPath, lockPath)
			rmSync(tmpPath, { force: true })
			const stopHeartbeat = startHeartbeat(lockPath, owner, now, heartbeatMs)
			return { release: () => releaseLock(lockPath, owner, stopHeartbeat) }
		} catch (err) {
			try {
				rmSync(tmpPath, { force: true })
			} catch {
				// Best-effort cleanup.
			}
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

function releaseLock(lockPath: string, owner: LockContents, stopHeartbeat: () => void): void {
	stopHeartbeat()
	// Read-then-delete has an inherent TOCTOU window (a rival takeover could
	// interleave). With the heartbeat publishing atomically, a rival takeover
	// of a live, fresh lock is already not possible; a stale takeover means
	// our nonce no longer matches, so the window is not exercised.
	try {
		// Ownership check: if a rival took the lock over while we were still
		// running (staleness escape), deleting the file would evict them and
		// invite a third installer to race theirs.
		const current = readLock(lockPath)
		if (current === null || current.pid !== owner.pid || current.nonce !== owner.nonce) return
		rmSync(lockPath, { force: true })
	} catch {
		// Best-effort.
	}
}

function startHeartbeat(lockPath: string, owner: LockContents, now: () => number, heartbeatMs: number): () => void {
	if (!(heartbeatMs > 0)) return () => {}
	const timer = setInterval(() => {
		try {
			const current = readLock(lockPath)
			if (current === null || current.pid !== owner.pid || current.nonce !== owner.nonce) {
				// Stolen: go quiet — refreshing would overwrite the usurper's record.
				clearInterval(timer)
				return
			}
			owner.at = now()
			// Publish atomically: rename replaces the target in one step, so a
			// concurrent acquirer can never read a truncated lock and treat it
			// as abandoned.
			const tmp = `${lockPath}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600 })
			renameSync(tmp, lockPath)
		} catch {
			// Best-effort: a failed beat only ages the lock one interval.
		}
	}, heartbeatMs)
	// The heartbeat must not keep a session alive after shutdown.
	timer.unref?.()
	return () => clearInterval(timer)
}

function defaultLockPath(): string {
	// state.json lives at <cache>/kimchi/state.json; the lock sits beside it.
	return join(dirname(statePath()), "updater.lock")
}
