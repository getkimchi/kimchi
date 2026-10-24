import { createHash } from "node:crypto"
import {
	COLLECTIONS,
	type Collection,
	LOGS,
	type LogName,
	ROW_KEYS,
	type Row,
	summaryLatest,
	type WorkHead,
	type WorkSummaryView,
} from "../../work-attribution/row-log.js"
import type { WorkRecord } from "../../work-attribution/summary.js"
import { mergeRecordsInto, type SummaryRows } from "./merge.js"
import { ensureProjectionVersion, type LedgerStore, openStore } from "./store.js"

/**
 * The one storage engine behind capture, import, the derived summary projection, and tracker bookkeeping. Both
 * backends (SQLite in production, in-memory in vitest) implement the same primitive contract; every higher-level
 * operation here is written once against it. Backends are resolved per agentDir and cached for the process.
 */

/** One durably stored work record. `body` is the canonical JSON of the record object. */
export interface StoredRecord {
	recordHash: string
	type: string
	workId: string
	sessionId: string
	body: string
	sourcePath: string | null
	sourceGeneration: number
	sourceOffset: number | null
	importedAt: number
}

/** Where the C3 importer stopped in one journal file; bytes [0, offset) are the consumed prefix. */
export interface JournalCursor {
	path: string
	dev: number
	ino: number
	generation: number
	offset: number
	boundaryHash: string
	updatedAt: number
}

/** Primitive storage contract; see schema.ts for the SQL tables and memory-records.ts for the test double. */
export interface RecordBackend {
	/** Runs `fn` atomically; no await may happen inside. */
	tx<T>(fn: () => T): T
	/** True when a NEW row was inserted; false when the record hash already exists (import dedup). */
	insertRecord(row: StoredRecord): boolean
	upsertMarker(recordHash: string, workId: string, type: string): void
	markDirty(workId: string): void
	clearDirty(workId: string): void
	dirtyWorks(): string[]
	getRow(workId: string, log: LogName, key: string): Row | undefined
	/** First-seen key keeps its position; a later write of the same key replaces the body in place. */
	putRow(workId: string, log: LogName, key: string, body: Row): void
	readLog(workId: string, log: LogName): Row[]
	/** Drops the work's projection rows and manifest; its records stay untouched. */
	clearProjection(workId: string): void
	getHead(workId: string): WorkHead | undefined
	putHead(head: WorkHead): void
	allHeads(): WorkHead[]
	readRecords(opts: { workId?: string; sessionId?: string; modifiedSince?: number }): StoredRecord[]
	recordCount(workId?: string): number
	/** Whether the projection has any plan or commit rows for the work. */
	hasProjectionOutput(workId: string): boolean
	hasNote(workId: string, name: string): boolean
	getNote(workId: string, name: string): string | undefined
	putNote(workId: string, name: string, body: string): void
	diagnostic(code: string): void
	getJournalCursor(path: string): JournalCursor | undefined
	putJournalCursor(cursor: JournalCursor): void
	/** Every cursor on record, so import can report files removed since the last pass. */
	listJournalCursors(): JournalCursor[]
	close(): void
}

const backends = new Map<string, RecordBackend>()
let factory: ((agentDir: string) => RecordBackend) | undefined

/** Tests register the in-memory backend; production always resolves the SQLite one. */
export function useBackendFactory(next: ((agentDir: string) => RecordBackend) | null): void {
	factory = next ?? undefined
}

export function backendFor(agentDir: string): RecordBackend {
	const found = backends.get(agentDir)
	if (found) return found
	const created = factory ? factory(agentDir) : sqliteBackend(agentDir)
	backends.set(agentDir, created)
	return created
}

/** Tests drop every cached backend between agent dirs. */
export function closeBackends(): void {
	for (const backend of backends.values()) backend.close()
	backends.clear()
}

/** Hash of the canonical record JSON; import hashes the re-stringified parsed line, which is byte-identical. */
export function recordHashOf(record: WorkRecord): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex")
}

/**
 * One capture: the record, its translation intent, and the derived projection all commit atomically. A crash
 * therefore leaves the record either fully durable with its projection, or absent — never half-captured.
 */
export function capture(agentDir: string, record: WorkRecord, sourcePath: string | null): void {
	const backend = backendFor(agentDir)
	const stored: StoredRecord = {
		recordHash: recordHashOf(record),
		type: record.type,
		workId: record.workId,
		sessionId: record.sessionId,
		body: JSON.stringify(record),
		sourcePath,
		sourceGeneration: 0,
		sourceOffset: null,
		importedAt: Date.now(),
	}
	backend.tx(() => {
		// A projection lost to a version bump or a bug is rebuilt before this record folds into it.
		if (!backend.getHead(record.workId) && backend.recordCount(record.workId) > 0)
			rebuildWorkInTx(backend, record.workId)
		backend.insertRecord(stored)
		backend.upsertMarker(stored.recordHash, record.workId, record.type)
		foldWork(backend, record.workId, [record])
	})
}

/** One journal line handed to the importer; the line bytes are the dedup key (sha256 of the exact line). */
export interface ImportEntry {
	line: string
	record: WorkRecord
	sourcePath: string
	sourceGeneration: number
	sourceOffset: number
}

/**
 * One import batch — rows, translation intent and projection fold — to be called inside an open `backend.tx`: the
 * C3 importer wraps rows and the cursor advance in the same transaction, so a kill mid-pass resumes at the cursor.
 * Duplicate lines (same hash) are skipped; the translation marker is upserted only for genuinely new rows. Only
 * NEWLY inserted rows fold into the projection, so a duplicate line re-imported after a file anomaly can never
 * overwrite newer captured state; a missing projection is still rebuilt from the whole authority.
 */
export function importBatchInTx(backend: RecordBackend, entries: ImportEntry[]): number {
	const insertedByWork = new Map<string, WorkRecord[]>()
	const touched = new Set<string>()
	let inserted = 0
	for (const entry of entries) {
		touched.add(entry.record.workId)
		const recordHash = createHash("sha256").update(entry.line).digest("hex")
		const stored: StoredRecord = {
			recordHash,
			type: entry.record.type,
			workId: entry.record.workId,
			sessionId: entry.record.sessionId,
			body: JSON.stringify(entry.record),
			sourcePath: entry.sourcePath,
			sourceGeneration: entry.sourceGeneration,
			sourceOffset: entry.sourceOffset,
			importedAt: Date.now(),
		}
		// Only genuinely new rows fold into the projection; a duplicate line (same hash) must never apply its
		// older body over newer captured state.
		if (!backend.insertRecord(stored)) continue
		inserted++
		backend.upsertMarker(recordHash, entry.record.workId, entry.record.type)
		let list = insertedByWork.get(entry.record.workId)
		if (!list) {
			list = []
			insertedByWork.set(entry.record.workId, list)
		}
		list.push(entry.record)
	}
	for (const workId of touched) {
		const records = insertedByWork.get(workId)
		// A projection lost to a version bump or a bug is rebuilt from the whole authority even when this
		// pass only saw duplicates; otherwise fold exactly the newly inserted rows.
		if (!backend.getHead(workId) && backend.recordCount(workId) > 0) {
			rebuildWorkInTx(backend, workId)
			continue
		}
		if (records?.length) foldWork(backend, workId, records)
	}
	return inserted
}

/** Replays stored records in capture/import order. */
export function readRecords(agentDir: string, opts: { workId?: string; modifiedSince?: number } = {}): WorkRecord[] {
	const records: WorkRecord[] = []
	for (const row of backendFor(agentDir).readRecords(opts)) {
		try {
			records.push(JSON.parse(row.body) as WorkRecord)
		} catch {
			// A damaged body cannot happen through capture or import; skip rather than fail every reader.
		}
	}
	return records
}

/** Changes whenever new records exist; capture-skip logic only needs that much honesty. */
export function fingerprint(agentDir: string): string {
	return String(backendFor(agentDir).recordCount())
}

/** The work's manifest, rebuilt from its records when the projection is missing. */
export function readWorkHead(agentDir: string, workId: string): WorkHead | undefined {
	const backend = backendFor(agentDir)
	const head = backend.getHead(workId)
	if (head) return head
	if (backend.recordCount(workId) === 0) return undefined
	backend.tx(() => rebuildWorkInTx(backend, workId))
	return backend.getHead(workId)
}

/** One collection's rows in first-seen order. */
export function readWorkRows(agentDir: string, workId: string, collection: Collection): Row[] | undefined {
	if (!readWorkHead(agentDir, workId)) return undefined
	return backendFor(agentDir).readLog(workId, collection)
}

/** The whole summary view; undefined when the work has no records. */
export function readWorkSummary(agentDir: string, workId: string): WorkSummaryView | undefined {
	if (!readWorkHead(agentDir, workId)) return undefined
	const backend = backendFor(agentDir)
	const sessions = backend.readLog(workId, "sessions").map((row) => String(row.sessionId))
	const collections = Object.fromEntries(COLLECTIONS.map((name) => [name, backend.readLog(workId, name)]))
	return { workId, sessions, ...collections } as WorkSummaryView
}

/** Every work that has a projection; `/work` discovery reads this instead of directories. */
export function listWorks(agentDir: string): { workId: string; head: WorkHead }[] {
	return backendFor(agentDir)
		.allHeads()
		.map((head) => ({ workId: head.workId, head }))
}

/** Refolds every work marked dirty; startup recovery and projection-version bumps land here. */
export function recoverDirty(agentDir: string): void {
	const backend = backendFor(agentDir)
	const dirty = backend.dirtyWorks()
	if (!dirty.length) return
	backend.tx(() => {
		for (const workId of dirty) rebuildWorkInTx(backend, workId)
	})
}

/** Deletes the work's projection and refolds it from its records; the authority is never touched. */
export function rebuildWork(agentDir: string, workId: string): void {
	const backend = backendFor(agentDir)
	backend.tx(() => rebuildWorkInTx(backend, workId))
}

function rebuildWorkInTx(backend: RecordBackend, workId: string): void {
	backend.clearProjection(workId)
	const records: WorkRecord[] = []
	for (const row of backend.readRecords({ workId })) {
		try {
			records.push(JSON.parse(row.body) as WorkRecord)
		} catch {
			// Skip damaged bodies; rebuild must not fail because one row is unreadable.
		}
	}
	mergeRecordsInto(projectionRows(backend, workId), records)
	backend.putHead(headFrom(backend, workId))
}

function foldWork(backend: RecordBackend, workId: string, records: WorkRecord[]): void {
	mergeRecordsInto(projectionRows(backend, workId), records)
	backend.putHead(headFrom(backend, workId))
}

function headFrom(backend: RecordBackend, workId: string): WorkHead {
	return {
		version: 2,
		workId,
		updatedAt: new Date().toISOString(),
		...summaryLatest((collection) => backend.readLog(workId, collection)),
		logs: logMetadata(backend, workId),
	}
}

function projectionRows(backend: RecordBackend, workId: string): SummaryRows {
	const sessions = {
		add(sessionId: string) {
			const key = ROW_KEYS.sessions({ sessionId })
			if (!backend.getRow(workId, "sessions", key)) backend.putRow(workId, "sessions", key, { sessionId })
		},
	}
	const store = (name: Collection) => ({
		get: (key: string) => backend.getRow(workId, name, key),
		has: (key: string) => backend.getRow(workId, name, key) !== undefined,
		// Merge output always carries sessionId, the one field Row demands beyond its index signature.
		set: (key: string, row: Record<string, unknown>) => backend.putRow(workId, name, key, row as Row),
	})
	return {
		sessions,
		...Object.fromEntries(COLLECTIONS.map((name) => [name, store(name)])),
	} as SummaryRows
}

/** Only non-empty logs appear in the manifest; empty collections are absent, as legacy readers expect. */
function logMetadata(backend: RecordBackend, workId: string): WorkHead["logs"] {
	const logs: WorkHead["logs"] = {}
	for (const log of LOGS) {
		const rows = backend.readLog(workId, log)
		if (!rows.length) continue
		const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row).length + 1, 0)
		logs[log] = { generation: 1, bytes, rows: rows.length }
	}
	return logs
}

/** Tracker bookkeeping (cost caches, issue, intent, scope, progress) as named JSON notes per work. */
export function getNote(agentDir: string, workId: string, name: string): string | undefined {
	return backendFor(agentDir).getNote(workId, name)
}

export function hasNote(agentDir: string, workId: string, name: string): boolean {
	return backendFor(agentDir).hasNote(workId, name)
}

/** Unchanged bodies are not rewritten, mirroring the old writeChanged helper. */
export function setNote(agentDir: string, workId: string, name: string, body: string): void {
	const backend = backendFor(agentDir)
	if (backend.getNote(workId, name) === body) return
	backend.putNote(workId, name, body)
}

export function diagnostic(agentDir: string, code: string): void {
	backendFor(agentDir).diagnostic(code)
}

/** Whole-view seeding for legacy fixture suites: inserts every session and collection row of the view. */
export function seedProjectionRows(agentDir: string, view: WorkSummaryView): void {
	const backend = backendFor(agentDir)
	backend.tx(() => {
		for (const sessionId of view.sessions)
			backend.putRow(view.workId, "sessions", ROW_KEYS.sessions({ sessionId }), { sessionId })
		for (const collection of COLLECTIONS)
			for (const row of view[collection] ?? []) backend.putRow(view.workId, collection, ROW_KEYS[collection](row), row)
		backend.putHead(headFrom(backend, view.workId))
	})
}

/** Timeout-free capture/read of one session's records, used by `getWorkId` identity resolution. */
export function ledgerSessionInfo(
	agentDir: string,
	sessionId: string,
): { work: WorkRecord | undefined; recordCount: number } {
	const rows = backendFor(agentDir).readRecords({ sessionId })
	const last = rows.filter((row) => row.type === "work").at(-1)
	return { work: last ? (JSON.parse(last.body) as WorkRecord) : undefined, recordCount: rows.length }
}

/** True when the work's projection has plan or commit rows (what /work lists as output evidence). */
export function ledgerHasWorkOutput(agentDir: string, workId: string): boolean {
	return backendFor(agentDir).hasProjectionOutput(workId)
}

/**
 * Test seam for the suites that seeded a derived summary directly (the old file fixtures): writes projection
 * rows and the head without inserting records, mirroring the old suite fixture behavior.
 */
export function seedProjection(
	agentDir: string,
	workId: string,
	options: {
		sessions?: string[]
		requestIds?: string[]
		plan?: { path: string; snapshotPath: string; repository: string }
	} = {},
): void {
	const backend = backendFor(agentDir)
	backend.tx(() => {
		for (const sessionId of options.sessions ?? ["seed"])
			backend.putRow(workId, "sessions", ROW_KEYS.sessions({ sessionId }), { sessionId })
		for (const requestId of options.requestIds ?? []) {
			const row = { sessionId: "seed", requestId }
			backend.putRow(workId, "requests", ROW_KEYS.requests(row), row)
		}
		if (options.plan) {
			const row = {
				sessionId: "seed",
				path: options.plan.path,
				snapshotPath: options.plan.snapshotPath,
				repository: options.plan.repository,
			}
			backend.putRow(workId, "plans", ROW_KEYS.plans(row), row)
		}
		backend.putHead(headFrom(backend, workId))
	})
}

/** The production backend over the C1 store. */
function sqliteBackend(agentDir: string): RecordBackend {
	const store: LedgerStore = openStore(agentDir)
	const db = store.db
	if (ensureProjectionVersion(store)) {
		db.query("INSERT OR IGNORE INTO work_dirty (work_id) SELECT DISTINCT work_id FROM work_records").run()
	}
	const insertRecord = db.query(
		// Targeted duplicate-hash no-op: any other integrity error surfaces and rolls the capture transaction back.
		"INSERT INTO work_records (record_hash, type, work_id, session_id, body, source_path, source_generation, source_offset, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_hash) DO NOTHING",
	)
	const upsertMarker = db.query(
		"INSERT OR REPLACE INTO pending_translation (record_hash, work_id, type, created_at) VALUES (?, ?, ?, ?)",
	)
	const getRow = db.query<{ body: string }, [string, string, string]>(
		"SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? AND key = ?",
	)
	const putRow = db.query(
		"INSERT INTO work_projection_rows (work_id, log, key, pos, body) VALUES (?, ?, ?, COALESCE((SELECT MAX(pos) + 1 FROM work_projection_rows WHERE work_id = ? AND log = ?), 1), ?) ON CONFLICT (work_id, log, key) DO UPDATE SET body = excluded.body",
	)
	const readLog = db.query<{ body: string }, [string, string]>(
		"SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? ORDER BY pos",
	)
	const getHead = db.query<{ body: string }, [string]>("SELECT body FROM work_projection_head WHERE work_id = ?")
	const putHead = db.query("INSERT OR REPLACE INTO work_projection_head (work_id, body, updated_at) VALUES (?, ?, ?)")
	const allHeads = db.query<{ body: string }, []>("SELECT body FROM work_projection_head")
	const clearRows = db.query("DELETE FROM work_projection_rows WHERE work_id = ?")
	const clearHead = db.query("DELETE FROM work_projection_head WHERE work_id = ?")
	const readRecordsAll = db.query<StoredRecord, []>(
		"SELECT record_hash AS recordHash, type, work_id AS workId, session_id AS sessionId, body, source_path AS sourcePath, source_generation AS sourceGeneration, source_offset AS sourceOffset, imported_at AS importedAt FROM work_records ORDER BY rowid",
	)
	const readRecordsWork = db.query<StoredRecord, [string]>(
		"SELECT record_hash AS recordHash, type, work_id AS workId, session_id AS sessionId, body, source_path AS sourcePath, source_generation AS sourceGeneration, source_offset AS sourceOffset, imported_at AS importedAt FROM work_records WHERE work_id = ? ORDER BY rowid",
	)
	const readRecordsSince = db.query<StoredRecord, [number]>(
		"SELECT record_hash AS recordHash, type, work_id AS workId, session_id AS sessionId, body, source_path AS sourcePath, source_generation AS sourceGeneration, source_offset AS sourceOffset, imported_at AS importedAt FROM work_records WHERE imported_at >= ? ORDER BY rowid",
	)
	const recordCountAll = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM work_records")
	const recordCountWork = db.query<{ count: number }, [string]>(
		"SELECT COUNT(*) AS count FROM work_records WHERE work_id = ?",
	)
	const dirty = db.query<{ work_id: string }, []>("SELECT work_id FROM work_dirty")
	const markDirty = db.query("INSERT OR IGNORE INTO work_dirty (work_id) VALUES (?)")
	const clearDirty = db.query("DELETE FROM work_dirty WHERE work_id = ?")
	const hasNote = db.query<{ one: number }, [string, string]>(
		"SELECT 1 AS one FROM bookkeeping WHERE work_id = ? AND name = ?",
	)
	const getNote = db.query<{ body: string }, [string, string]>(
		"SELECT body FROM bookkeeping WHERE work_id = ? AND name = ?",
	)
	const putNote = db.query("INSERT OR REPLACE INTO bookkeeping (work_id, name, body, updated_at) VALUES (?, ?, ?, ?)")
	const getCursor = db.query<JournalCursor, [string]>(
		"SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor WHERE path = ?",
	)
	const allCursors = db.query<JournalCursor, []>(
		"SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor ORDER BY path",
	)
	const putCursor = db.query(
		"INSERT OR REPLACE INTO journal_cursor (path, dev, ino, generation, offset, boundary_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
	const bumpDiagnostic = db.query(
		"INSERT INTO diagnostics (code, count, updated_at) VALUES (?, 1, ?) ON CONFLICT (code) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at",
	)
	const rowsOf = (workId: string, log: LogName): Row[] =>
		readLog.all(workId, log).map((row) => JSON.parse(row.body) as Row)
	return {
		tx: <T>(fn: () => T): T => store.tx(fn),
		insertRecord: (row) =>
			insertRecord.run(
				row.recordHash,
				row.type,
				row.workId,
				row.sessionId,
				row.body,
				row.sourcePath,
				row.sourceGeneration,
				row.sourceOffset,
				row.importedAt,
			).changes > 0,
		upsertMarker: (recordHash, workId, type) => upsertMarker.run(recordHash, workId, type, Date.now()),
		markDirty: (workId) => markDirty.run(workId),
		clearDirty: (workId) => clearDirty.run(workId),
		dirtyWorks: () => dirty.all().map((row) => row.work_id),
		getRow: (workId, log, key) => {
			const found = getRow.get(workId, log, key)
			return found ? (JSON.parse(found.body) as Row) : undefined
		},
		putRow: (workId, log, key, body) => putRow.run(workId, log, key, workId, log, JSON.stringify(body)),
		readLog: rowsOf,
		clearProjection: (workId) => {
			clearRows.run(workId)
			clearHead.run(workId)
		},
		getHead: (workId) => {
			const found = getHead.get(workId)
			return found ? (JSON.parse(found.body) as WorkHead) : undefined
		},
		putHead: (head) => putHead.run(head.workId, JSON.stringify(head), Date.now()),
		allHeads: () => allHeads.all().map((row) => JSON.parse(row.body) as WorkHead),
		readRecords: (opts) => {
			let rows =
				opts.workId !== undefined
					? readRecordsWork.all(opts.workId)
					: opts.modifiedSince !== undefined
						? readRecordsSince.all(opts.modifiedSince)
						: readRecordsAll.all()
			if (opts.sessionId !== undefined) rows = rows.filter((row) => row.sessionId === opts.sessionId)
			return rows
		},
		hasProjectionOutput: (workId) =>
			readLog.all(workId, "plans").length > 0 || readLog.all(workId, "commits").length > 0,
		recordCount: (workId) => (workId ? (recordCountWork.get(workId)?.count ?? 0) : (recordCountAll.get()?.count ?? 0)),
		hasNote: (workId, name) => hasNote.get(workId, name) != null,
		getNote: (workId, name) => getNote.get(workId, name)?.body,
		putNote: (workId, name, body) => putNote.run(workId, name, body, Date.now()),
		diagnostic: (code) => bumpDiagnostic.run(code, Date.now()),
		getJournalCursor: (path) => getCursor.get(path) ?? undefined,
		putJournalCursor: (cursor) =>
			putCursor.run(
				cursor.path,
				cursor.dev,
				cursor.ino,
				cursor.generation,
				cursor.offset,
				cursor.boundaryHash,
				cursor.updatedAt,
			),
		listJournalCursors: () => allCursors.all(),
		close: () => store.close(),
	}
}
