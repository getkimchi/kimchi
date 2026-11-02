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
 * retries transient SQLITE_BUSY for a short window (an attempt started at the
 * deadline can still wait one busy timeout inside SQLite), because SQLite
 * does not invoke the busy handler for WAL shared-memory locks during a
 * concurrent WAL upgrade of a fresh database.
 */
import type * as Sqlite from "bun:sqlite"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { reportingDirectory } from "../queue.js"
import {
	LEDGER_SCHEMA,
	META_PROJECTION_VERSION,
	OUTBOX_SENDABLE_INDEX,
	PROJECTION_VERSION,
	SCHEMA_VERSION,
} from "./schema.js"

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

/** The ledger lives beside the reporting state.json, in the same private directory. */
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

/** Per-connection busy timeout. */
const BUSY_TIMEOUT_MS = 5000
/**
 * Open-retry window. The loser of the fresh-database WAL-upgrade race only waits for the winner to
 * finish the upgrade and schema create: measured max 19ms over 120 three-way contended opens, so 1s
 * leaves wide headroom while capping the synchronous event-loop stall.
 */
const OPEN_RETRY_BUDGET_MS = 1000

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isBusy(error: unknown): boolean {
	return String((error as { code?: unknown } | null)?.code ?? "").startsWith("SQLITE_BUSY")
}

/**
 * Runs attempt, retrying with capped exponential backoff while it throws an SQLITE_BUSY* error and the
 * budget lasts. Any other error, or the last busy error once the budget is spent, is rethrown. An attempt
 * started just before the deadline may still wait inside SQLite, so the worst case is the budget plus one busy timeout.
 * attempt must be safe to repeat and release its own resources when it throws.
 */
export function retryOnBusy<T>(
	attempt: () => T,
	budgetMs: number,
	clock: { now(): number; sleep(ms: number): void } = { now: Date.now, sleep: sleepSync },
): T {
	const deadline = clock.now() + budgetMs
	for (let delay = 10; ; delay = Math.min(delay * 2, 250)) {
		try {
			return attempt()
		} catch (error) {
			const remaining = deadline - clock.now()
			if (!isBusy(error) || remaining <= 0) throw error
			clock.sleep(Math.min(delay, remaining))
		}
	}
}

/**
 * Opens (and on first use creates) the ledger. Foreign schemas fail closed:
 * the file is left exactly as found, and callers report the collector degraded
 * instead of writing records a different build cannot read.
 *
 * The whole open is retried on SQLITE_BUSY*: SQLite does not invoke the busy handler for WAL
 * shared-memory locks during a concurrent WAL upgrade of a fresh database, so two processes opening
 * the same brand-new ledger race past busy_timeout and the loser fails instantly.
 */
export function openStore(agentDir: string): LedgerStore {
	const { Database } = bunSqlite()
	const path = ledgerDbPath(agentDir)
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	closeSync(openSync(path, "a", 0o600))
	return retryOnBusy(() => {
		let db: Sqlite.Database | undefined
		try {
			const ledger = new Database(path, { create: true, strict: true })
			db = ledger
			// Connection-local: even the first schema read may race another process's initialization.
			ledger.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
			// Read the version before any persisting pragma so a foreign database is left exactly as found.
			const version = ledger.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0
			const decision = classifyUserVersion(version)
			if (decision === "foreign") throw new LedgerSchemaError(version)
			ledger.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON")
			// Large journal imports repeatedly touch the record and marker indexes; this connection-local cache is allocated on demand.
			ledger.exec("PRAGMA cache_size=-131072")
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
			// The optional index upgrades v1 ledgers without changing the version older builds read. Defer its
			// installation if another process holds the writer lock rather than blocking startup for five seconds.
			if (!ledger.query("SELECT 1 FROM sqlite_master WHERE type='index' AND name='outbox_sendable'").get()) {
				ledger.exec("PRAGMA busy_timeout=50")
				try {
					ledger.exec(OUTBOX_SENDABLE_INDEX)
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")) throw error
				} finally {
					ledger.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`)
				}
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
			throw error
		}
	}, OPEN_RETRY_BUDGET_MS)
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
