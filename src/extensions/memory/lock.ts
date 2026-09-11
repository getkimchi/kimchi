/**
 * The capture drain lock — serializes capture workers and management
 * resets against the memory root. proper-lockfile resolves the target with
 * realpath (which requires the file to exist), so the lock target is
 * touched first — same pattern as src/ferment/event-store.ts.
 */
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { CAPTURE_LOCK_STALE_MS, CAPTURE_LOCK_UPDATE_MS } from "./config.js"

/**
 * Acquire the capture lock for a memory root. The mtime refresh keeps a
 * live holder from looking stale; a crashed holder's lock is stealable
 * after the staleness window. Later callers wait (5s poll, up to 1h).
 * The returned release logs (never throws) on a best-effort failure.
 */
export async function acquireCaptureLock(memoryRoot: string): Promise<() => Promise<void>> {
	const lockFile = join(memoryRoot, "capture.lock")
	mkdirSync(memoryRoot, { recursive: true })
	if (!existsSync(lockFile)) {
		closeSync(openSync(lockFile, "a"))
	}
	const release = await lock(lockFile, {
		stale: CAPTURE_LOCK_STALE_MS,
		update: CAPTURE_LOCK_UPDATE_MS,
		retries: { retries: 720, factor: 1, minTimeout: 5_000, maxTimeout: 5_000 },
	})
	return async () => {
		try {
			await release()
		} catch (err) {
			// Best-effort — e.g. a stale-recovery path already released it;
			// never mask the operation's own result.
			console.error("[memory] capture lock release failed:", err instanceof Error ? err.message : err)
		}
	}
}
