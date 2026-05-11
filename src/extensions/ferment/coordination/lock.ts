import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { lock } from "proper-lockfile"

interface LockMeta {
	claimedAt: number
	claimer: string
}

async function readLockMeta(lockPath: string): Promise<LockMeta | null> {
	try {
		const raw = await readFile(lockPath, "utf-8")
		return JSON.parse(raw) as LockMeta
	} catch {
		return null
	}
}

export interface ClaimOptions {
	/** Stable agent identifier e.g. 'agent:kimchi-tdd-router:abc123' */
	claimer: string
	/** ID of the work item (used to derive lock path) */
	itemId: string
	/** Path to the work-item JSON file (for reference, not used for lock key) */
	itemPath: string
	/** Stale lock TTL in seconds. Default 900. */
	staleSeconds?: number
}

export interface ClaimHandle {
	release(): Promise<void>
}

/**
 * Derive the lock-file path from a work-item path.
 * Lock lives at `.kimchi/coordination/.locks/<itemId>.lock` — a fixed location
 * that does not change when the work-item JSON moves between state directories.
 */
function lockPathFromItemPath(itemPath: string, itemId: string): string {
	return resolve(itemPath, "..", "..", ".kimchi", "coordination", ".locks", `${itemId}.lock`)
}

export async function claimItem(opts: ClaimOptions): Promise<ClaimHandle | null> {
	const lockPath = lockPathFromItemPath(opts.itemPath, opts.itemId)
	const locksDir = resolve(opts.itemPath, "..", "..", ".kimchi", "coordination", ".locks")

	await mkdir(locksDir, { recursive: true })

	const staleMs = (opts.staleSeconds ?? 900) * 1000

	// Step 1: Check for an existing (possibly stale) lock by reading the metadata file.
	// This tells us if another process is actively holding the lock.
	const existing = await readLockMeta(lockPath)
	if (existing) {
		const age = Date.now() - existing.claimedAt
		if (age <= staleMs) {
			// Lock is active (claimed recently enough) — return null so caller
			// knows it's taken. We do NOT attempt to remove it.
			return null
		}
		// Lock is stale — remove it before we can acquire. The stale holder
		// may be dead (process killed, laptop slept). We are entitled to reclaim.
		try {
			await unlink(lockPath)
		} catch {
			// Best-effort; another process may have cleaned it up concurrently
		}
	}

	// Step 2: Ensure the lock file exists (proper-lockfile requires it)
	const fh = await open(lockPath, "a")
	await fh.close()

	// Step 3: Write our claim metadata
	await writeFile(lockPath, JSON.stringify({ claimedAt: Date.now(), claimer: opts.claimer }), "utf-8")

	// Step 4: Acquire proper-lockfile lock.
	// We use a very large stale value (1 week) to effectively skip proper-lockfile's
	// own mtime-based stale detection — we handle staleness ourselves via claimedAt.
	// This avoids graceful-fs stat caching issues that make mtime-based detection
	// unreliable in vitest.
	const STALE_DISABLED = 7 * 24 * 60 * 60 * 1000 // 1 week in ms
	let releaseLock: (() => Promise<void>) | undefined
	try {
		releaseLock = await lock(lockPath, { stale: STALE_DISABLED, retries: 0 })
	} catch (err: unknown) {
		if (err instanceof Error && "code" in err && (err as { code: string }).code === "ELOCKED") {
			// We lost a tight race — another process acquired between our
			// stale-check and our lock() call. Clean up our stale metadata.
			try {
				const meta = await readLockMeta(lockPath)
				if (meta && Date.now() - meta.claimedAt > staleMs) {
					await unlink(lockPath)
				}
			} catch {
				// Best-effort
			}
			return null
		}
		throw err
	}

	return {
		release: async () => {
			try {
				await releaseLock?.()
			} catch {
				// Best-effort — may already be released
			}
			try {
				await unlink(lockPath)
			} catch {
				// Already gone
			}
		},
	}
}
