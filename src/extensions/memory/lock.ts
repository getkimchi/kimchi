/**
 * The capture drain lock — serializes capture workers and management
 * resets against the memory root. proper-lockfile resolves the target with
 * realpath (which requires the file to exist), so the lock target is
 * touched first — same pattern as src/ferment/event-store.ts.
 *
 * Fast-break for dead holders: the lock records its owning pid in a
 * sidecar file (`capture.lock.pid`). A competing worker polls the lock
 * every POLL_MS; before each retry it checks the sidecar — if the holder
 * pid is dead (ESRCH), it breaks the lock immediately instead of waiting
 * the full CAPTURE_LOCK_STALE_MS mtime window. Stale-by-age remains the
 * fallback for a holder that never wrote a sidecar (a crash between
 * acquire and the sidecar write).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { CAPTURE_LOCK_STALE_MS, CAPTURE_LOCK_UPDATE_MS } from "./config.js"

const POLL_MS = 5_000
const MAX_ATTEMPTS = 720 // 1h — same ceiling as the pre-sidecar retry loop

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
 */
export function breakIfHolderDead(lockFile: string): boolean {
	const pidFile = `${lockFile}.pid`
	if (!existsSync(pidFile)) return false
	let pid: number
	try {
		pid = Number(readFileSync(pidFile, "utf-8").trim())
	} catch {
		return false
	}
	if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false
	if (processAlive(pid)) return false
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
 */
export async function acquireCaptureLock(
	memoryRoot: string,
	options?: { pollMs?: number },
): Promise<() => Promise<void>> {
	const pollMs = options?.pollMs ?? POLL_MS
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
			if (!isLockConflict(err) || attempt >= MAX_ATTEMPTS) throw err
			breakIfHolderDead(lockFile)
			await sleep(pollMs)
		}
	}
}
