/**
 * Bun-backed SQLite implementation of CaptureJobStore. The adapter is loaded
 * lazily so Node/unit-test imports never construct a database.
 */
import { existsSync, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import type { CaptureJobRecord, CaptureJobState, CaptureJobStore } from "./capture-jobs.js"
import {
	type CaptureMigrationAudit,
	type CaptureMigrationProgress,
	migrateLegacyCaptureState,
} from "./capture-migration.js"
import type { CaptureJob } from "./capture-worker.js"

interface SqliteStatement {
	run(...params: unknown[]): unknown
	get(...params: unknown[]): unknown
	all(...params: unknown[]): unknown[]
}

interface SqliteDatabase {
	prepare(sql: string): SqliteStatement
	exec(sql: string): void
	transaction<T>(fn: () => T): () => T
	close(): void
}

interface DatabaseConstructor {
	new (path: string): SqliteDatabase
}

interface JobRow {
	job_file: string
	job_json: string
	state: CaptureJobState
	mtime_ms: number
	enqueue_seq: number
}

function driver(): DatabaseConstructor {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require("better-sqlite3") as DatabaseConstructor
}

function numeric(row: unknown, field: string): number {
	if (!row || typeof row !== "object") return 0
	const value = (row as Record<string, unknown>)[field]
	return typeof value === "number" ? value : Number(value ?? 0)
}

/** Database-backed implementation; no mirrored in-memory job map retained. */
export class SqliteCaptureJobStore implements CaptureJobStore {
	private readonly db: SqliteDatabase
	private readonly root: string

	constructor(root = defaultMemoryDir()) {
		this.root = root
		mkdirSync(root, { recursive: true })
		this.db = new (driver())(join(root, "capture-jobs.db"))
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				job_file TEXT PRIMARY KEY,
				enqueue_seq INTEGER NOT NULL,
				job_json TEXT NOT NULL,
				state TEXT NOT NULL,
				mtime_ms INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS message_hashes (
				hash TEXT PRIMARY KEY,
				job_file TEXT
			);
			CREATE TABLE IF NOT EXISTS migration_metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS jobs_state_mtime ON jobs(state, mtime_ms, job_file);
		`)
	}

	upsert(
		jobFile: string,
		job: CaptureJob,
		state: CaptureJobState = "pending",
		mtimeMs?: number,
		sequence = this.nextSequence(),
	): void {
		const timestamp =
			mtimeMs ?? this.storedMtimeMs(jobFile) ?? (existsSync(jobFile) ? statSync(jobFile).mtimeMs : Date.now())
		this.db
			.prepare(`
				INSERT INTO jobs(job_file, enqueue_seq, job_json, state, mtime_ms)
				VALUES(?, ?, ?, ?, ?)
				ON CONFLICT(job_file) DO UPDATE SET job_json=excluded.job_json, state=excluded.state, mtime_ms=excluded.mtime_ms
			`)
			.run(jobFile, sequence, JSON.stringify(job), state, timestamp)
	}

	private storedMtimeMs(jobFile: string): number | undefined {
		const row = this.db.prepare("SELECT mtime_ms FROM jobs WHERE job_file = ?").get(jobFile) as
			| { mtime_ms?: number }
			| undefined
		return row ? numeric(row, "mtime_ms") : undefined
	}

	private storedJob(jobFile: string): CaptureJob | undefined {
		const row = this.db.prepare("SELECT job_json FROM jobs WHERE job_file = ?").get(jobFile) as
			| { job_json?: string }
			| undefined
		return typeof row?.job_json === "string" ? (JSON.parse(row.job_json) as CaptureJob) : undefined
	}

	private nextSequence(): number {
		return numeric(this.db.prepare("SELECT COALESCE(MAX(enqueue_seq), 0) + 1 AS next_seq FROM jobs").get(), "next_seq")
	}

	upsertMany(records: readonly CaptureJobRecord[]): void {
		this.db.transaction(() => {
			let sequence = this.nextSequence()
			for (const record of records) {
				this.upsert(record.jobFile, record.job, record.state, record.mtimeMs, sequence++)
			}
		})()
	}

	pending(limit: number, exclude?: ReadonlySet<string>): string[] {
		if (Number.isNaN(limit) || limit <= 0) return []
		const wanted = Math.floor(limit)
		const pageSize = Math.min(Math.max(wanted, 96), 2048)
		const excluded = [...(exclude ?? [])]
		const exclusion = excluded.length > 0 ? `AND job_file NOT IN (${excluded.map(() => "?").join(",")})` : ""
		const statement = this.db.prepare(`
			SELECT job_file FROM jobs
			WHERE state = 'pending' ${exclusion}
			ORDER BY mtime_ms, job_file LIMIT ? OFFSET ?
		`)
		const pending: string[] = []
		let offset = 0
		while (pending.length < wanted) {
			const rows = statement.all(...excluded, pageSize, offset) as JobRow[]
			for (const row of rows) {
				if (existsSync(row.job_file)) {
					pending.push(row.job_file)
					if (pending.length === wanted) break
				}
			}
			offset += rows.length
			if (rows.length < pageSize) break
		}
		return pending
	}

	/** Query plan used by scale tests to prove indexed pending lookup. */
	pendingQueryPlan(limit = 96): unknown[] {
		return this.db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT job_file FROM jobs WHERE state = 'pending' ORDER BY mtime_ms, job_file LIMIT ?",
			)
			.all(limit)
	}

	stateOf(jobFile: string): CaptureJobState | undefined {
		const row = this.db.prepare("SELECT state FROM jobs WHERE job_file = ?").get(jobFile) as
			| { state?: CaptureJobState }
			| undefined
		return row?.state
	}

	count(state?: CaptureJobState): number {
		if (!state) return numeric(this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get(), "n")
		return numeric(this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = ?").get(state), "n")
	}

	hashes(): Set<string> {
		return new Set(
			this.db
				.prepare("SELECT hash FROM message_hashes")
				.all()
				.map((row) => String((row as { hash: string }).hash)),
		)
	}

	markHashes(hashes: Iterable<string>): void {
		this.db.transaction(() => {
			const stmt = this.db.prepare("INSERT OR IGNORE INTO message_hashes(hash, job_file) VALUES(?, NULL)")
			for (const hash of hashes) stmt.run(hash)
		})()
	}

	setState(jobFile: string, state: CaptureJobState, job?: CaptureJob, mtimeMs?: number): void {
		const current =
			job ?? this.storedJob(jobFile) ?? (existsSync(jobFile) ? readCaptureJobFile(jobFile) : { messages: [] })
		if (state === "failed") {
			const pendingPath = join(this.root, "pending", jobFile.split("/").pop() ?? jobFile)
			if (pendingPath !== jobFile) this.db.prepare("DELETE FROM jobs WHERE job_file = ?").run(pendingPath)
		}
		this.upsert(jobFile, current, state, mtimeMs)
	}

	oldestPendingAgeMs(now: number): number | undefined {
		const oldest = numeric(
			this.db.prepare("SELECT MIN(mtime_ms) AS oldest FROM jobs WHERE state = 'pending'").get(),
			"oldest",
		)
		return oldest === 0 ? undefined : now - oldest
	}

	reset(): void {
		this.db.exec("DELETE FROM jobs; DELETE FROM message_hashes; DELETE FROM migration_metadata;")
	}

	legacyCaptureMigrationComplete(): boolean {
		const row = this.db.prepare("SELECT value FROM migration_metadata WHERE key = ?").get("legacy-capture") as
			| { value?: string }
			| undefined
		return row?.value === "complete-v1"
	}

	markLegacyCaptureMigrationComplete(): void {
		this.db
			.prepare("INSERT OR REPLACE INTO migration_metadata(key, value) VALUES('legacy-capture', 'complete-v1')")
			.run()
	}

	close(): void {
		this.db.close()
	}
}

function readCaptureJobFile(jobFile: string): CaptureJob {
	return JSON.parse(require("node:fs").readFileSync(jobFile, "utf-8")) as CaptureJob
}

/** Create a queue, explicitly completing unfinished legacy migration. */
export function createSqliteCaptureJobStore(
	root = defaultMemoryDir(),
	onProgress?: CaptureMigrationProgress,
): {
	store: SqliteCaptureJobStore
	migration: CaptureMigrationAudit | undefined
} {
	const store = new SqliteCaptureJobStore(root)
	return {
		store,
		migration: store.legacyCaptureMigrationComplete()
			? undefined
			: migrateLegacyCaptureState(store, root, 500, undefined, onProgress),
	}
}
