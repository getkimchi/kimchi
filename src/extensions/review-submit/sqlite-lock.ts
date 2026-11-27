import type { Database as BunDatabase } from "bun:sqlite"
import { createRequire } from "node:module"
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite"

const LOCK_BUSY_TIMEOUT_MS = 6_000

interface SQLiteConnection {
	exec(sql: string): void
	close(): void
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
