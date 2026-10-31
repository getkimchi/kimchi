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
 * store test via the Bun driver), never corruption. The open path additionally
 * retries transient SQLITE_BUSY for up to one busy-timeout window (a single
 * in-flight attempt can absorb a second window inside SQLite), because SQLite
 * does not invoke the busy handler for WAL shared-memory locks during a
 * concurrent WAL upgrade of a fresh database.
 */
import type * as Sqlite from "bun:sqlite"
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

let sqlite: typeof Sqlite | undefined
function bunSqlite(): typeof Sqlite {
	if (!sqlite) {
		try {
			sqlite = createRequire(import.meta.url)("bun:sqlite") as typeof Sqlite
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
	readonly db: Sqlite.Database
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
/** Shared wall-clock budget for the per-connection busy timeout and the open-retry deadline. */
const OPEN_BUSY_BUDGET_MS = 5000

export function openStore(agentDir: string): LedgerStore {
	const { Database } = bunSqlite()
	const path = ledgerDbPath(agentDir)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	closeSync(openSync(path, "a", 0o600))
	// Retry the whole open (construction included) on any SQLITE_BUSY* code: the busy handler is
	// not invoked for WAL shared-memory locks during a concurrent WAL upgrade of a fresh database,
	// so two processes opening the same brand-new ledger race past busy_timeout and the loser fails
	// instantly (observed in 0ms). An attempt started just before the deadline may still wait up to
	// busy_timeout inside SQLite, so the worst-case open is roughly twice the budget.
	const deadline = Date.now() + OPEN_BUSY_BUDGET_MS
	for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
		let db: Sqlite.Database | undefined
		try {
			const ledger = new Database(path, { create: true, strict: true })
			db = ledger
			// Connection-local: even the first schema read may race another process's initialization.
			ledger.exec(`PRAGMA busy_timeout=${OPEN_BUSY_BUDGET_MS}`)
			// Read the version before any persisting pragma so a foreign database is left exactly as found.
			const version = ledger.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
			const decision = classifyUserVersion(version)
			if (decision === "foreign") throw new LedgerSchemaError(version)
			ledger.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
			if (decision === "create") {
				ledger
					.transaction(() => {
						// Re-read inside the immediate lock: a concurrent process may have finished creating (or written a
						// foreign version) between the outer read and this transaction.
						const again = ledger.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
						if (again === SCHEMA_VERSION) return
						if (classifyUserVersion(again) === "foreign") throw new LedgerSchemaError(again)
						ledger.exec(LEDGER_SCHEMA)
						ledger.exec(`PRAGMA user_version=${SCHEMA_VERSION}`)
					})
					.immediate()
			}
			return {
				db: ledger,
				path,
				tx: <T>(fn: () => T): T => ledger.transaction(fn).immediate(),
				close: () => ledger.close(),
			}
		} catch (error) {
			try {
				db?.close()
			} catch {
				// A failed close never masks the original open error.
			}
			const busy = String((error as { code?: unknown }).code ?? "").startsWith("SQLITE_BUSY")
			const remaining = deadline - Date.now()
			if (!busy || remaining <= 0) throw error
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, remaining))
		}
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
