/**
 * Open/guard logic for the PR-cost ledger (src/extensions/pr-cost-reporting/ledger/).
 *
 * Runtime strategy (plan Decision 8): record capture and reads are synchronous
 * callers, so the `bun:sqlite` binding is loaded with a synchronous
 * `createRequire("bun:sqlite")`, lazily, on first open — never at module import,
 * so Node/vitest loads this module fine. Production always runs Bun; opening the
 * database under Node throws LedgerUnavailableError.
 *
 * Durability and concurrency: WAL with synchronous=FULL replaces the per-append
 * fsync of the journal era; a 5s busy timeout orders concurrent Kimchi processes;
 * a writer that cannot get the lock within it surfaces SQLITE_BUSY (proven by the
 * store test via the Bun driver), never corruption.
 */
import { closeSync, mkdirSync, openSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { reportingDirectory } from "../queue.js"
import { LEDGER_SCHEMA, META_PROJECTION_VERSION, PROJECTION_VERSION, SCHEMA_VERSION } from "./schema.js"

/** Thrown when the database cannot be opened in this runtime (no bun:sqlite). */
export class LedgerUnavailableError extends Error {
	readonly code = "pr-cost-ledger/unavailable"
	constructor(cause: unknown) {
		super("PR-cost ledger requires the Bun runtime (bun:sqlite)", { cause })
		this.name = "LedgerUnavailableError"
	}
}

/** Thrown when the database on disk was written by an incompatible schema; nothing is written. */
export class LedgerSchemaError extends Error {
	readonly code = "pr-cost-ledger/future-schema"
	constructor(readonly found: number) {
		super(`PR-cost ledger schema ${found} is not schema ${SCHEMA_VERSION}; refusing to write`)
		this.name = "LedgerSchemaError"
	}
}

type Sqlite = typeof import("bun:sqlite")
type Database = import("bun:sqlite").Database

let sqlite: Sqlite | undefined
function bunSqlite(): Sqlite {
	if (!sqlite) {
		try {
			sqlite = createRequire(import.meta.url)("bun:sqlite") as Sqlite
		} catch (error) {
			throw new LedgerUnavailableError(error)
		}
	}
	return sqlite
}

/** The ledger lives beside the legacy state.json queue, inheriting its directory's lock discipline. */
export function ledgerDbPath(agentDir: string): string {
	return join(reportingDirectory(agentDir), "ledger.db")
}

/** Pure version decision, unit-tested without a database. */
export function classifyUserVersion(version: number): "create" | "open" | "foreign" {
	if (version === 0) return "create"
	return version === SCHEMA_VERSION ? "open" : "foreign"
}

export interface LedgerStore {
	readonly db: Database
	readonly path: string
	/** Run fn in an immediate transaction: all-or-nothing commit for capture/import/ACK points. */
	tx<T>(fn: () => T): T
	close(): void
}

/**
 * Opens (and on first use creates) the ledger. Foreign schemas fail closed:
 * the file is left exactly as found, and callers report the collector degraded
 * instead of writing records a different build cannot read.
 */
export function openStore(agentDir: string): LedgerStore {
	const { Database } = bunSqlite()
	const path = ledgerDbPath(agentDir)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	closeSync(openSync(path, "a", 0o600))
	const db = new Database(path, { create: true, strict: true })
	try {
		// Connection-local: even the first schema read may race another process's initialization.
		db.exec("PRAGMA busy_timeout=5000")
		// Read the version before any persisting pragma so a foreign database is left exactly as found.
		const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
		switch (classifyUserVersion(version)) {
			case "foreign":
				throw new LedgerSchemaError(version)
			default:
				db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
		}
		if (classifyUserVersion(version) === "create") {
			db.transaction(() => {
				// Re-read inside the immediate lock: a concurrent process may have finished creating (or written a
				// foreign version) between the outer read and this transaction.
				const again = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
				if (again === SCHEMA_VERSION) return
				if (classifyUserVersion(again) === "foreign") throw new LedgerSchemaError(again)
				db.exec(LEDGER_SCHEMA)
				db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
			}).immediate()
		}
	} catch (error) {
		db.close()
		throw error
	}
	return {
		db,
		path,
		tx: <T>(fn: () => T): T => db.transaction(fn).immediate(),
		close: () => db.close(),
	}
}

/**
 * Clears the derived projection when its format version changed, so readers
 * rebuild from the authority table. Authority and outbox rows are never touched.
 */
export function ensureProjectionVersion(store: LedgerStore): boolean {
	const row = store.db
		.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
		.get(META_PROJECTION_VERSION)
	if (row && Number(row.value) === PROJECTION_VERSION) return false
	store.tx(() => {
		store.db.run("DELETE FROM work_projection_rows")
		store.db.run("DELETE FROM work_projection_head")
		store.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
			META_PROJECTION_VERSION,
			String(PROJECTION_VERSION),
		])
	})
	return true
}
