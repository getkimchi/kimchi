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
	/** Hard-link primitive; injectable to simulate filesystems without hard links. */
	linkFile?: (existingPath: string, newPath: string) => void
	/** Return a no-op handle instead of null when the lock file cannot be
	 *  written (e.g. a root-owned cache dir). For manual updates: the user asked
	 *  for this install, and a broken cache must not read as "update in progress".
	 *  A lock held by a live session still returns null. */
	allowUnavailable?: boolean
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

/** Link errors meaning "this filesystem has no hard links", not "the lock exists". */
const HARD_LINK_UNSUPPORTED = new Set(["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"])

/** The lock file's contents, or null when there is no file. A file that exists
 *  but can't be read reads as empty, which parses as a corrupt lock. */
function readRawLock(lockPath: string): string | null {
	try {
		return readFileSync(lockPath, "utf-8")
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : ""
	}
}

function readLock(lockPath: string): LockContents | null {
	const raw = readRawLock(lockPath)
	return raw === null ? null : parseLock(raw)
}

function parseLock(raw: string): LockContents | null {
	try {
		const parsed: unknown = JSON.parse(raw)
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
		// Unparseable — treated as an abandoned lock.
	}
	return null
}

/**
 * Try to take the updater lock. Returns a handle when acquired, null when
 * another live session holds it. A lock whose owner is dead — or whose
 * contents are unparseable — is taken over: the stale file is claimed (see
 * claimStaleLock) and the create is retried once. If two sessions race for the
 * takeover, one wins and the loser gets null.
 *
 * Never throws: a broken filesystem must not stop the calling tick from
 * launching normally. It returns null, or a no-op handle with `allowUnavailable`.
 *
 * Note: killing a session mid-acquire can strand an `*.tmp` file in the
 * cache dir; callers ignore it (it is never linked into place).
 */
export function acquireUpdaterLock(opts: AcquireOptions = {}): UpdaterLock | null {
	const lockPath = opts.lockPath ?? defaultLockPath()
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive
	const now = opts.now ?? Date.now

	const heartbeatMs = opts.heartbeatMs ?? LOCK_HEARTBEAT_MS
	const linkFile = opts.linkFile ?? linkSync

	const tmpPath = `${lockPath}.${process.pid}.tmp`
	for (let attempt = 0; attempt < 2; attempt++) {
		// Kept apart from the publish below: mkdir also throws EEXIST when a file
		// blocks the path, and only the publish's EEXIST means "the lock exists".
		const owner: LockContents = { pid: process.pid, at: now(), nonce: randomUUID() }
		const content = JSON.stringify(owner)
		try {
			mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
			writeFileSync(tmpPath, content, { mode: 0o600 })
		} catch {
			return opts.allowUnavailable ? { release: () => {} } : null
		}
		try {
			// Publish atomically: a bare create-then-write would leave an empty
			// or truncated file a rival could read as an abandoned lock. Write a
			// temp file, then hard-link it into place — link fails with EEXIST
			// when the target exists, which is the same atomic O_EXCL guarantee
			// but the file never appears half-written.
			publishExclusive(tmpPath, lockPath, content, linkFile)
			rmSync(tmpPath, { force: true })
			const stopHeartbeat = startHeartbeat(lockPath, owner, now, heartbeatMs)
			return { release: () => releaseLock(lockPath, owner, stopHeartbeat) }
		} catch (err) {
			try {
				rmSync(tmpPath, { force: true })
			} catch {
				// Best-effort cleanup.
			}
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return opts.allowUnavailable ? { release: () => {} } : null
			const observed = readRawLock(lockPath)
			// Gone already (the holder just released): the retry below decides.
			if (observed === null) continue
			const contents = parseLock(observed)
			const held =
				contents !== null &&
				isPidAlive(contents.pid) &&
				contents.at !== undefined &&
				now() - contents.at < LOCK_STALE_MS
			if (held) return null
			// Stale (dead owner), corrupt, or aged out: claim it and retry once.
			if (!claimStaleLock(lockPath, observed, linkFile)) return null
		}
	}
	return null
}

/** Create `lockPath` from `tmpPath`, failing with EEXIST if it already exists.
 *  Filesystems without hard links fall back to an exclusive create, which keeps
 *  the exclusion but can briefly expose an empty file to a rival's read. */
function publishExclusive(
	tmpPath: string,
	lockPath: string,
	content: string,
	linkFile: NonNullable<AcquireOptions["linkFile"]>,
): void {
	try {
		linkFile(tmpPath, lockPath)
	} catch (err) {
		if (!HARD_LINK_UNSUPPORTED.has((err as NodeJS.ErrnoException).code ?? "")) throw err
		writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 })
	}
}

/**
 * Remove a lock judged stale, without evicting a rival that replaced it after
 * we read it. A plain delete can't tell the two apart: rename moves whatever is
 * there now aside, then we compare it to what we judged. A mismatch means we
 * took a live lock, so it goes back and we lose the race. The holder's heartbeat
 * can read the file as missing during that instant; it skips that beat and
 * resumes once the file is back.
 *
 * Returns true when the caller may retry the create.
 */
function claimStaleLock(
	lockPath: string,
	observed: string,
	linkFile: NonNullable<AcquireOptions["linkFile"]>,
): boolean {
	const claimPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`
	try {
		renameSync(lockPath, claimPath)
	} catch (err) {
		// Already gone: a rival claimed it, and the create decides between us.
		return (err as NodeJS.ErrnoException).code === "ENOENT"
	}
	try {
		const claimed = readRawLock(claimPath)
		if (claimed === observed) return true
		if (claimed !== null) publishExclusive(claimPath, lockPath, claimed, linkFile)
		return false
	} catch {
		// The restore lost to yet another session, which now holds the lock.
		return false
	} finally {
		try {
			rmSync(claimPath, { force: true })
		} catch {
			// Best-effort cleanup.
		}
	}
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
			// Missing or unparseable doesn't prove a theft: a rival's claim moves the
			// file aside for an instant and may restore it, and a rival's fallback
			// create can briefly show an empty file. Writing now could overwrite the
			// rival, and stopping would let a lock we still hold age out. Wait for
			// the next beat.
			if (current === null) return
			if (current.pid !== owner.pid || current.nonce !== owner.nonce) {
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
