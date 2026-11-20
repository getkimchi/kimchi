/**
 * The capture drain lock — serializes capture workers and management
 * resets against the memory root. proper-lockfile resolves the target with
 * realpath (which requires the file to exist), so the lock target is
 * touched first — same pattern as src/ferment/event-store.ts.
 *
 * Fail-fast under live contention: a competing worker tries once; if the
 * lock is held by a LIVE holder (sidecar pid alive), the caller gets null
 * and defers — the pending/ queue is the durable medium and the holder's
 * drain re-lists it before releasing, so queue-waiting only parks a full
 * process runtime per waiter (the bench showed 7 workers idling while one
 * drained). Dead-holder fast-break: the sidecar records the owning pid;
 * a dead holder's lock is broken immediately instead of waiting the full
 * CAPTURE_LOCK_STALE_MS mtime window. Stale-by-age remains the fallback
 * for a holder that never wrote a sidecar (a crash between acquire and
 * the sidecar write).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { CAPTURE_LOCK_STALE_MS, CAPTURE_LOCK_UPDATE_MS } from "./config.js"

const POLL_MS = 5_000

/** Dead-hold signature: a live holder refreshes the lock dir mtime every
 * CAPTURE_LOCK_UPDATE_MS — an mtime frozen past three update cycles can
 * only be a dead holder, sidecar or not. */
const DEAD_MTIME_FREEZE_MS = CAPTURE_LOCK_UPDATE_MS * 3

function isLockConflict(err: unknown): boolean {
	return (err as { code?: string }).code === "ELOCKED"
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		// EPERM means "exists but not ours to signal" — still alive.
		return (err as { code?: string }).code === "EPERM"
	}
}

/**
 * Best-effort break of a lock whose recorded holder is no longer running.
 * Returns true when the lock was broken; any failure (missing sidecar,
 * alive holder, concurrent re-acquire mid-break) leaves the lock alone.
 *
 * Sidecar-absent fallback: no pid to liveness-check, but a holder with
 * update: CAPTURE_LOCK_UPDATE_MS refreshes the dir mtime every cycle —
 * an mtime frozen past DEAD_MTIME_FREEZE_MS (3 cycles) is a dead hold
 * (this is how the no-sidecar crash path recovers long before the
 * 15-min staleness window).
 */
export function breakIfHolderDead(lockFile: string): boolean {
	const pidFile = `${lockFile}.pid`
	if (!existsSync(pidFile)) {
		try {
			const dirMtime = statSync(`${lockFile}.lock`).mtimeMs
			if (Date.now() - dirMtime < DEAD_MTIME_FREEZE_MS) return false
		} catch {
			return false
		}
	} else {
		let pid: number
		try {
			pid = Number(readFileSync(pidFile, "utf-8").trim())
		} catch {
			return false
		}
		if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false
		if (processAlive(pid)) return false
	}
	// Break by removing the lock DIR directly: proper-lockfile's own
	// break primitive refuses a lock younger than the stale window, which
	// is exactly the case we are handling (dead holder, fresh mtime).
	// A live worker re-acquiring between our liveness check and here
	// re-creates its sidecar, so a mistaken break costs one polling
	// cycle of overlapped ownership, not correctness: the drain is
	// idempotent against the shared ledger.
	try {
		rmSync(`${lockFile}.lock`, { recursive: true, force: true })
	} catch {
		return false
	}
	try {
		rmSync(pidFile, { force: true })
	} catch {
		// the sidecar is informational — leaving it behind is harmless
	}
	return true
}

/**
 * Acquire the capture lock for a memory root. The mtime refresh keeps a
 * live holder from looking stale; a crashed holder's lock is broken as
 * soon as a caller sees the dead pid in the sidecar, or (no sidecar)
 * after the staleness window. The returned release logs (never throws)
 * on a best-effort failure.
 *
 * Live-holder contention FAILS FAST: returns null so the caller defers
 * (the active drain processes the whole pending/ queue, including the
 * caller's own job file). One immediate retry follows a successful
 * dead-holder break so a steal doesn't cost a spawn.
 */
export async function acquireCaptureLock(
	memoryRoot: string,
	options?: { pollMs?: number },
): Promise<(() => Promise<void>) | null> {
	const lockFile = join(memoryRoot, "capture.lock")
	const pidFile = `${lockFile}.pid`
	mkdirSync(memoryRoot, { recursive: true })
	if (!existsSync(lockFile)) {
		closeSync(openSync(lockFile, "a"))
	}
	for (let attempt = 0; ; attempt++) {
		try {
			const release = await lock(lockFile, {
				stale: CAPTURE_LOCK_STALE_MS,
				update: CAPTURE_LOCK_UPDATE_MS,
				retries: 0,
			})
			try {
				writeFileSync(pidFile, String(process.pid))
			} catch {
				// sidecar is best-effort — failure falls back to mtime-staleness
			}
			return async () => {
				try {
					rmSync(pidFile, { force: true })
				} catch {
					// sidecar removal is best-effort
				}
				try {
					await release()
				} catch (err) {
					// Best-effort — e.g. a stale-recovery path already released it;
					// never mask the operation's own result.
					console.error("[memory] capture lock release failed:", err instanceof Error ? err.message : err)
				}
			}
		} catch (err) {
			if (!isLockConflict(err)) throw err
			// Dead holder: break immediately and retry right away, one fold
			// of the poll loop — the only wait a steal pays.
			if (attempt === 0 && breakIfHolderDead(lockFile)) {
				await sleep(options?.pollMs ?? POLL_MS)
				continue
			}
			return null // live holder — defer (queue-waiting parks processes)
		}
	}
}
