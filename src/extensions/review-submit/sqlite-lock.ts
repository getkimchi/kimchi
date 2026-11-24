import type { Database as BunDatabase } from "bun:sqlite"
import { readdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname } from "node:path"
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite"

const LOCK_BUSY_TIMEOUT_MS = 6_000

interface SQLiteConnection {
	exec(sql: string): void
	close(): void
}

interface LegacyOwnerRecord {
	pid: number
	process_starttime?: string
}

const require = createRequire(import.meta.url)
const processTurns = new Map<string, Promise<void>>()

export class WriterLockUnavailableError extends Error {}
export class WriterLockReleaseError extends Error {}

function openConnection(path: string): SQLiteConnection {
	if (process.versions.bun) {
		const { Database } = require("bun:sqlite") as { Database: typeof BunDatabase }
		return new Database(path)
	}
	const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof NodeDatabaseSync }
	return new DatabaseSync(path)
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code
}

async function processStartTime(pid: number): Promise<string | undefined> {
	if (process.platform !== "linux") return undefined
	try {
		const contents = await readFile(`/proc/${pid}/stat`, "utf8")
		const commandEnd = contents.lastIndexOf(")")
		if (commandEnd < 0) return undefined
		return contents
			.slice(commandEnd + 1)
			.trim()
			.split(/\s+/)[19]
	} catch {
		return undefined
	}
}

async function legacyOwnerIsAlive(record: LegacyOwnerRecord): Promise<boolean> {
	try {
		process.kill(record.pid, 0)
	} catch (error) {
		return errorCode(error) !== "ESRCH"
	}
	if (record.process_starttime === undefined) return true
	const currentStart = await processStartTime(record.pid)
	return currentStart === undefined || currentStart === record.process_starttime
}

function parseLegacyOwner(contents: string): LegacyOwnerRecord | undefined {
	try {
		const value = JSON.parse(contents) as Partial<LegacyOwnerRecord> | null
		if (value === null || !Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid < 1) {
			return undefined
		}
		if (value.process_starttime !== undefined && typeof value.process_starttime !== "string") return undefined
		return { pid: value.pid, process_starttime: value.process_starttime }
	} catch {
		return undefined
	}
}

async function cleanupLegacyOwnerTemps(lockFilePath: string): Promise<void> {
	// These are unique per-acquisition names from the previous owner-record
	// protocol. A token is never reused or renamed back into its temp path, so
	// after proving its creator dead, unlinking that exact inode is safe. Never
	// use mtime or the main owner record as a cleanup target: a live successor
	// could own those. Malformed records and live/uncertain PIDs are left alone.
	const legacyBase = basename(lockFilePath).replace(/\.sqlite$/, "")
	for (const name of await readdir(dirname(lockFilePath))) {
		if (!name.startsWith(`.${legacyBase}.`) || !name.endsWith(".tmp")) continue
		const path = `${dirname(lockFilePath)}/${name}`
		try {
			const owner = parseLegacyOwner(await readFile(path, "utf8"))
			if (owner && !(await legacyOwnerIsAlive(owner))) await rm(path, { force: true })
		} catch {
			// Orphan cleanup is best-effort and never blocks a valid submission.
		}
	}
}

async function waitForProcessTurn(path: string): Promise<() => void> {
	const previous = processTurns.get(path) ?? Promise.resolve()
	let finish = () => {}
	const turn = new Promise<void>((resolve) => (finish = resolve))
	const tail = previous.then(() => turn)
	processTurns.set(path, tail)
	await previous
	return () => {
		finish()
		if (processTurns.get(path) === tail) processTurns.delete(path)
	}
}

/** Serialize one writer per output writer across both JS tasks and OS processes.
 * The SQLite connection and its native lock remain open across awaits for the
 * complete caller critical section; process death makes the kernel release it. */
export async function withSQLiteWriterLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	beforeRelease?: () => void | Promise<void>,
): Promise<T> {
	const finishProcessTurn = await waitForProcessTurn(filePath)
	let connection: SQLiteConnection | undefined
	let transactionStarted = false
	let releaseError: unknown
	let outcome: { result: T } | { error: unknown }
	try {
		try {
			connection = openConnection(filePath)
			connection.exec(`PRAGMA busy_timeout=${LOCK_BUSY_TIMEOUT_MS}`)
			// Do not change journal_mode during acquisition: a concurrent mode
			// return may report SQLITE_BUSY immediately instead of honoring the
			// timeout. The default rollback journal serializes BEGIN IMMEDIATE.
			connection.exec("BEGIN IMMEDIATE")
			transactionStarted = true
		} catch (error) {
			const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
			throw new WriterLockUnavailableError(`Could not obtain the SQLite review writer lock: ${reason}`, {
				cause: error,
			})
		}
		await cleanupLegacyOwnerTemps(filePath)
		const result = await fn()
		await beforeRelease?.()
		outcome = { result }
	} catch (error) {
		outcome = { error }
	} finally {
		if (transactionStarted) {
			try {
				connection?.exec("ROLLBACK")
			} catch (error) {
				releaseError = error
			}
		}
		try {
			connection?.close()
		} catch (error) {
			releaseError ??= error
		}
		finishProcessTurn()
	}
	if (releaseError) {
		throw new WriterLockReleaseError("Could not release the SQLite review writer lock", { cause: releaseError })
	}
	if ("error" in outcome) throw outcome.error
	return outcome.result
}
