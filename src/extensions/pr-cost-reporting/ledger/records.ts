import { createHash } from "node:crypto"
import { setImmediate } from "node:timers/promises"
import {
	COLLECTIONS,
	type Collection,
	commitPullRequests,
	type LogName,
	observeLatest,
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

/** A stable insertion position for bounded authority reads; never a projection position. */
export interface PositionedRecord extends StoredRecord {
	position: number
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

export interface OutboxEvent {
	id: string
	accountKey: string
	entityId: string
	kind: string
	body: Uint8Array
	hash: string
	createdAt: number
	ackedAt: number | null
	blocked: string
}

export interface OutboxBatch {
	id: string
	accountKey: string
	body: Uint8Array
	eventIds: string[]
	createdAt: number
	orderKey: string
}

export interface OutboxAccountStatus {
	accountKey: string
	pending: number
	sendable: number
	blocked: number
	acknowledged: number
	lastAcknowledgedAt: number | null
	batches: number
	firstBatchId: string | null
}

/** Primitive storage contract; see schema.ts for the SQL tables and memory-records.ts for the test double. */
export interface RecordBackend {
	/** Runs `fn` atomically; no await may happen inside. */
	tx<T>(fn: () => T): T
	/** True when a NEW row was inserted; false when the record hash already exists (import dedup). */
	insertRecord(row: StoredRecord): boolean
	upsertMarker(recordHash: string, workId: string, type: string): void
	pendingTranslations(after: number, through: number, limit: number): PositionedRecord[]
	/** Every record not yet translated into events, by work. */
	markedRecords(): { recordHash: string; workId: string; type: string }[]
	clearTranslation(recordHash: string): void
	/** The entity's newest event that was not set aside. */
	latestOutboxEvent(accountKey: string, entityId: string): OutboxEvent | undefined
	getOutboxEvent(accountKey: string, id: string): OutboxEvent | undefined
	outboxEntityEvents(accountKey: string, entityId: string): OutboxEvent[]
	unblockedOutboxEventCount(accountKey: string, entityId: string): number
	insertOutboxEvent(event: OutboxEvent): void
	pendingOutboxEvents(accountKey: string, limit: number): OutboxEvent[]
	outboxStatus(): OutboxAccountStatus[]
	getOutboxBatch(accountKey: string): OutboxBatch | undefined
	insertOutboxBatch(batch: OutboxBatch): void
	ackOutboxEvent(accountKey: string, id: string, hash: string, at: number): boolean
	/** Sets an unacknowledged event aside for `reason`; it stays out of every later batch. */
	blockOutboxEvent(accountKey: string, id: string, hash: string, reason: string): boolean
	deleteOutboxBatch(accountKey: string, id: string): boolean
	markDirty(workId: string): void
	clearDirty(workId: string): void
	dirtyWorks(): string[]
	getRow(workId: string, log: LogName, key: string): Row | undefined
	/** A new key takes position `pos`; a later write of the same key replaces the body and keeps its position. */
	putRow(workId: string, log: LogName, key: string, body: Row, pos: number): void
	readLog(workId: string, log: LogName): Row[]
	/** Drops the work's projection rows and manifest; its records stay untouched. */
	clearProjection(workId: string): void
	getHead(workId: string): WorkHead | undefined
	putHead(head: WorkHead): void
	allHeads(): WorkHead[]
	readRecords(
		opts: { workId?: string; sessionId?: string; modifiedSince?: number; type?: string },
		checkBudget?: () => void,
	): StoredRecord[]
	/** Pins an async read to the records committed when it started. */
	recordWatermark(): number
	readRecordPage(
		after: number,
		through: number,
		limit: number,
		checkBudget?: () => void,
		workId?: string,
	): PositionedRecord[]
	recordCount(workId?: string): number
	/** Whether the projection has any plan or commit rows for the work. */
	hasProjectionOutput(workId: string): boolean
	hasNote(workId: string, name: string): boolean
	getNote(workId: string, name: string): string | undefined
	putNote(workId: string, name: string, body: string): void
	deleteNote(workId: string, name: string): void
	diagnostic(code: string): void
	getJournalCursor(path: string): JournalCursor | undefined
	putJournalCursor(cursor: JournalCursor): void
	deleteJournalCursor(path: string): void
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

/** Hash used for native capture; imported records retain the hash of their exact original line bytes. */
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
export function readRecords(
	agentDir: string,
	opts: { workId?: string; modifiedSince?: number; type?: WorkRecord["type"] } = {},
	checkBudget?: () => void,
): WorkRecord[] {
	checkBudget?.()
	const records: WorkRecord[] = []
	for (const row of backendFor(agentDir).readRecords(opts, checkBudget)) {
		checkBudget?.()
		try {
			records.push(JSON.parse(row.body) as WorkRecord)
		} catch {
			// A damaged body cannot happen through capture or import; skip rather than fail every reader.
		}
	}
	return records
}

/** No transaction or live iterator crosses a yield; appends beyond the watermark belong to the next read. */
async function readRecordPrefixAsync<T>(
	agentDir: string,
	checkBudget: () => void,
	project: (row: StoredRecord) => T | undefined,
	workIds?: readonly string[],
): Promise<T[]> {
	checkBudget()
	const backend = backendFor(agentDir)
	const through = backend.recordWatermark()
	const records: T[] = []
	for (const workId of workIds ?? [undefined]) {
		let after = 0
		while (after < through) {
			await setImmediate()
			checkBudget()
			const page = backend.readRecordPage(after, through, 128, checkBudget, workId)
			if (!page.length) break
			for (const row of page) {
				checkBudget()
				const value = project(row)
				if (value !== undefined) records.push(value)
			}
			after = page[page.length - 1].position
		}
	}
	checkBudget()
	return records
}

/** Retain original capture/import hashes for atomic translation; never hash the reserialized body instead. */
export function readStoredRecordsAsync(agentDir: string, checkBudget: () => void): Promise<StoredRecord[]> {
	return readRecordPrefixAsync(agentDir, checkBudget, (row) => row)
}

/** Preserve work-group order while reading each work from the same pinned authority prefix. */
export function readGroupStoredRecordsAsync(
	agentDir: string,
	workIds: readonly string[],
	checkBudget: () => void,
): Promise<StoredRecord[]> {
	return readRecordPrefixAsync(agentDir, checkBudget, (row) => row, workIds)
}

export function readRecordsAsync(agentDir: string, checkBudget: () => void): Promise<WorkRecord[]> {
	return readRecordPrefixAsync(agentDir, checkBudget, (row) => {
		try {
			return JSON.parse(row.body) as WorkRecord
		} catch {
			// Match the synchronous reader's damaged-body behavior.
			return undefined
		}
	})
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
	const head = emptyHead(workId)
	mergeRecordsInto(projectionRows(backend, head), records)
	backend.putHead({
		...head,
		updatedAt: new Date().toISOString(),
		...summaryLatest((collection) => backend.readLog(workId, collection)),
	})
	backend.clearDirty(workId)
}

/** Folds records into the saved head like the journal-era summary writer: only the rows they touch are read. */
function foldWork(backend: RecordBackend, workId: string, records: WorkRecord[]): void {
	const head = backend.getHead(workId) ?? emptyHead(workId)
	let commits = false
	mergeRecordsInto(
		projectionRows(backend, head, (collection, row) => {
			observeLatest(head.latest, collection, row)
			commits ||= collection === "commits"
		}),
		records,
	)
	if (commits) head.pullRequests = commitPullRequests(backend.readLog(workId, "commits"))
	backend.putHead({ ...head, updatedAt: new Date().toISOString() })
}

function emptyHead(workId: string): WorkHead {
	return { version: 2, workId, updatedAt: "", logs: {}, latest: {}, pullRequests: [] }
}

/**
 * Projection writes for one head. Each log's row count and size continue from the head, so writing a row never
 * rereads the rest of the work; only non-empty logs appear in the manifest, as legacy readers expect.
 */
function projectionRows(
	backend: RecordBackend,
	head: WorkHead,
	onSet?: (collection: Collection, row: Row) => void,
): SummaryRows {
	const { workId, logs } = head
	/** Stored size of each row this fold has seen; undefined while the key is new. */
	const sizes = new Map<string, number | undefined>()
	const get = (log: LogName, key: string) => {
		const row = backend.getRow(workId, log, key)
		sizes.set(`${log}\u0000${key}`, row && Buffer.byteLength(JSON.stringify(row)))
		return row
	}
	const put = (log: LogName, key: string, row: Row) => {
		const id = `${log}\u0000${key}`
		if (!sizes.has(id)) get(log, key)
		const previous = sizes.get(id)
		const bytes = Buffer.byteLength(JSON.stringify(row))
		logs[log] ??= { generation: 1, bytes: 0, rows: 0 }
		const meta = logs[log]
		if (previous === undefined) {
			meta.rows++
			meta.bytes += bytes + 1
		} else meta.bytes += bytes - previous
		backend.putRow(workId, log, key, row, meta.rows)
		sizes.set(id, bytes)
	}
	const sessions = {
		add(sessionId: string) {
			const key = ROW_KEYS.sessions({ sessionId })
			if (!get("sessions", key)) put("sessions", key, { sessionId })
		},
	}
	const store = (name: Collection) => ({
		get: (key: string) => get(name, key),
		has: (key: string) => get(name, key) !== undefined,
		// Merge output always carries sessionId, the one field Row demands beyond its index signature.
		set: (key: string, row: Record<string, unknown>) => {
			put(name, key, row as Row)
			onSet?.(name, row as Row)
		},
	})
	return {
		sessions,
		...Object.fromEntries(COLLECTIONS.map((name) => [name, store(name)])),
	} as SummaryRows
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
		const head = backend.getHead(view.workId) ?? emptyHead(view.workId)
		const rows = projectionRows(backend, head)
		for (const sessionId of view.sessions) rows.sessions.add(sessionId)
		for (const collection of COLLECTIONS)
			for (const row of view[collection] ?? []) rows[collection].set(ROW_KEYS[collection](row), row)
		backend.putHead({
			...head,
			updatedAt: new Date().toISOString(),
			...summaryLatest((collection) => backend.readLog(view.workId, collection)),
		})
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
	const translations = db.query<PositionedRecord, [number, number, number]>(
		"SELECT w.rowid AS position, w.record_hash AS recordHash, w.type, w.work_id AS workId, w.session_id AS sessionId, w.body, w.source_path AS sourcePath, w.source_generation AS sourceGeneration, w.source_offset AS sourceOffset, w.imported_at AS importedAt FROM pending_translation p JOIN work_records w ON w.record_hash = p.record_hash WHERE w.rowid > ? AND w.rowid <= ? ORDER BY w.rowid LIMIT ?",
	)
	const clearTranslation = db.query("DELETE FROM pending_translation WHERE record_hash = ?")
	const marked = db.query<{ recordHash: string; workId: string; type: string }, []>(
		"SELECT record_hash AS recordHash, work_id AS workId, type FROM pending_translation",
	)
	const eventColumns =
		"id, account_key AS accountKey, entity_id AS entityId, kind, body, hash, created_at AS createdAt, acked_at AS ackedAt, blocked"
	const latestEvent = db.query<OutboxEvent, [string, string]>(
		`SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND entity_id = ? AND blocked = '' ORDER BY rowid DESC LIMIT 1`,
	)
	const getEvent = db.query<OutboxEvent, [string, string]>(
		`SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND id = ?`,
	)
	const entityEvents = db.query<OutboxEvent, [string, string]>(
		`SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND entity_id = ? ORDER BY rowid`,
	)
	const unblockedEventCount = db.query<{ count: number }, [string, string]>(
		"SELECT COUNT(*) AS count FROM outbox_events WHERE account_key = ? AND entity_id = ? AND blocked = ''",
	)
	const insertEvent = db.query(
		"INSERT INTO outbox_events (id, account_key, entity_id, kind, body, hash, created_at, acked_at, blocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
	const pendingEvents = db.query<OutboxEvent, [string, number]>(
		`SELECT ${eventColumns} FROM outbox_events WHERE account_key = ? AND acked_at IS NULL AND blocked = '' ORDER BY rowid LIMIT ?`,
	)
	const pendingBatch = db.query<Omit<OutboxBatch, "eventIds"> & { eventIds: Uint8Array }, [string]>(
		"SELECT id, account_key AS accountKey, body, event_ids AS eventIds, created_at AS createdAt, order_key AS orderKey FROM outbox_batches WHERE account_key = ? ORDER BY order_key, created_at, rowid LIMIT 1",
	)
	const insertBatch = db.query(
		"INSERT INTO outbox_batches (id, account_key, body, event_ids, created_at, order_key) VALUES (?, ?, ?, ?, ?, ?)",
	)
	const ackEvent = db.query(
		"UPDATE outbox_events SET acked_at = ? WHERE account_key = ? AND id = ? AND hash = ? AND acked_at IS NULL",
	)
	const blockEvent = db.query(
		"UPDATE outbox_events SET blocked = ? WHERE account_key = ? AND id = ? AND hash = ? AND acked_at IS NULL AND blocked = ''",
	)
	const deleteBatch = db.query("DELETE FROM outbox_batches WHERE account_key = ? AND id = ?")
	const outboxStatus = db.query<OutboxAccountStatus, []>(`
		SELECT a.account_key AS accountKey, COALESCE(e.pending, 0) AS pending,
			COALESCE(e.sendable, 0) AS sendable, COALESCE(e.blocked, 0) AS blocked,
			COALESCE(e.acknowledged, 0) AS acknowledged, e.lastAcknowledgedAt,
			COALESCE(b.batches, 0) AS batches,
			(SELECT id FROM outbox_batches WHERE account_key = a.account_key
				ORDER BY order_key, created_at, rowid LIMIT 1) AS firstBatchId
		FROM (SELECT account_key FROM outbox_events UNION SELECT account_key FROM outbox_batches) a
		LEFT JOIN (SELECT account_key, SUM(acked_at IS NULL) AS pending,
			SUM(acked_at IS NULL AND blocked = '') AS sendable,
			SUM(acked_at IS NULL AND blocked != '') AS blocked,
			SUM(acked_at IS NOT NULL) AS acknowledged, MAX(acked_at) AS lastAcknowledgedAt
			FROM outbox_events GROUP BY account_key) e USING (account_key)
		LEFT JOIN (SELECT account_key, COUNT(*) AS batches FROM outbox_batches GROUP BY account_key) b
			USING (account_key)
		ORDER BY a.account_key
	`)
	const getRow = db.query<{ body: string }, [string, string, string]>(
		"SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? AND key = ?",
	)
	const putRow = db.query(
		"INSERT INTO work_projection_rows (work_id, log, key, pos, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (work_id, log, key) DO UPDATE SET body = excluded.body",
	)
	const readLog = db.query<{ body: string }, [string, string]>(
		"SELECT body FROM work_projection_rows WHERE work_id = ? AND log = ? ORDER BY pos",
	)
	const getHead = db.query<{ body: string }, [string]>("SELECT body FROM work_projection_head WHERE work_id = ?")
	const putHead = db.query("INSERT OR REPLACE INTO work_projection_head (work_id, body, updated_at) VALUES (?, ?, ?)")
	const allHeads = db.query<{ body: string }, []>("SELECT body FROM work_projection_head")
	const clearRows = db.query("DELETE FROM work_projection_rows WHERE work_id = ?")
	const clearHead = db.query("DELETE FROM work_projection_head WHERE work_id = ?")
	const recordColumns =
		"record_hash AS recordHash, type, work_id AS workId, session_id AS sessionId, body, source_path AS sourcePath, source_generation AS sourceGeneration, source_offset AS sourceOffset, imported_at AS importedAt"
	const readRecordsAll = db.query<StoredRecord, []>(`SELECT ${recordColumns} FROM work_records ORDER BY rowid`)
	const readRecordsWork = db.query<StoredRecord, [string]>(
		`SELECT ${recordColumns} FROM work_records WHERE work_id = ? ORDER BY rowid`,
	)
	const readRecordsSince = db.query<StoredRecord, [number]>(
		`SELECT ${recordColumns} FROM work_records WHERE imported_at >= ? ORDER BY rowid`,
	)
	const readRecordsSession = db.query<StoredRecord, [string]>(
		`SELECT ${recordColumns} FROM work_records WHERE session_id = ? ORDER BY rowid`,
	)
	const readRecordsType = db.query<StoredRecord, [string]>(
		`SELECT ${recordColumns} FROM work_records WHERE type = ? ORDER BY rowid`,
	)
	const watermark = db.query<{ position: number }, []>("SELECT COALESCE(MAX(rowid), 0) AS position FROM work_records")
	const recordPage = db.query<PositionedRecord, [number, number, number]>(
		`SELECT rowid AS position, ${recordColumns} FROM work_records WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
	)
	const recordPageWork = db.query<PositionedRecord, [string, number, number, number]>(
		`SELECT rowid AS position, ${recordColumns} FROM work_records WHERE work_id = ? AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
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
	const deleteNote = db.query("DELETE FROM bookkeeping WHERE work_id = ? AND name = ?")
	const getCursor = db.query<JournalCursor, [string]>(
		"SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor WHERE path = ?",
	)
	const allCursors = db.query<JournalCursor, []>(
		"SELECT path, dev, ino, generation, offset, boundary_hash AS boundaryHash, updated_at AS updatedAt FROM journal_cursor ORDER BY path",
	)
	const putCursor = db.query(
		"INSERT OR REPLACE INTO journal_cursor (path, dev, ino, generation, offset, boundary_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
	const deleteCursor = db.query("DELETE FROM journal_cursor WHERE path = ?")
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
		pendingTranslations: (after, through, limit) => translations.all(after, through, limit),
		markedRecords: () => marked.all(),
		clearTranslation: (recordHash) => clearTranslation.run(recordHash),
		latestOutboxEvent: (accountKey, entityId) => latestEvent.get(accountKey, entityId) ?? undefined,
		getOutboxEvent: (accountKey, id) => getEvent.get(accountKey, id) ?? undefined,
		outboxEntityEvents: (accountKey, entityId) => entityEvents.all(accountKey, entityId),
		unblockedOutboxEventCount: (accountKey, entityId) => unblockedEventCount.get(accountKey, entityId)?.count ?? 0,
		insertOutboxEvent: (event) =>
			insertEvent.run(
				event.id,
				event.accountKey,
				event.entityId,
				event.kind,
				event.body,
				event.hash,
				event.createdAt,
				event.ackedAt,
				event.blocked,
			),
		pendingOutboxEvents: (accountKey, limit) => pendingEvents.all(accountKey, limit),
		outboxStatus: () => outboxStatus.all(),
		getOutboxBatch: (accountKey) => {
			const batch = pendingBatch.get(accountKey)
			return batch ? { ...batch, eventIds: JSON.parse(Buffer.from(batch.eventIds).toString("utf8")) } : undefined
		},
		insertOutboxBatch: (batch) =>
			insertBatch.run(
				batch.id,
				batch.accountKey,
				batch.body,
				Buffer.from(JSON.stringify(batch.eventIds)),
				batch.createdAt,
				batch.orderKey,
			),
		ackOutboxEvent: (accountKey, id, hash, at) => ackEvent.run(at, accountKey, id, hash).changes > 0,
		blockOutboxEvent: (accountKey, id, hash, reason) => blockEvent.run(reason, accountKey, id, hash).changes > 0,
		deleteOutboxBatch: (accountKey, id) => deleteBatch.run(accountKey, id).changes > 0,
		markDirty: (workId) => markDirty.run(workId),
		clearDirty: (workId) => clearDirty.run(workId),
		dirtyWorks: () => dirty.all().map((row) => row.work_id),
		getRow: (workId, log, key) => {
			const found = getRow.get(workId, log, key)
			return found ? (JSON.parse(found.body) as Row) : undefined
		},
		putRow: (workId, log, key, body, pos) => putRow.run(workId, log, key, pos, JSON.stringify(body)),
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
		readRecords: (opts, checkBudget) => {
			checkBudget?.()
			// An index narrows the read; any other option filters its rows.
			const source =
				opts.workId !== undefined
					? readRecordsWork.iterate(opts.workId)
					: opts.type !== undefined
						? readRecordsType.iterate(opts.type)
						: opts.modifiedSince !== undefined
							? readRecordsSince.iterate(opts.modifiedSince)
							: opts.sessionId !== undefined
								? readRecordsSession.iterate(opts.sessionId)
								: readRecordsAll.iterate()
			const rows: StoredRecord[] = []
			try {
				for (const row of source) {
					checkBudget?.()
					if (
						(opts.sessionId === undefined || row.sessionId === opts.sessionId) &&
						(opts.type === undefined || row.type === opts.type) &&
						(opts.modifiedSince === undefined || row.importedAt >= opts.modifiedSince)
					)
						rows.push(row)
				}
			} catch (error) {
				// Bun 1.4 leaves an interrupted iterator's cursor positioned mid-result.
				// get() resets before and after one row; it never drains the remaining history.
				if (opts.workId !== undefined) readRecordsWork.get(opts.workId)
				else if (opts.type !== undefined) readRecordsType.get(opts.type)
				else if (opts.modifiedSince !== undefined) readRecordsSince.get(opts.modifiedSince)
				else if (opts.sessionId !== undefined) readRecordsSession.get(opts.sessionId)
				else readRecordsAll.get()
				throw error
			}
			return rows
		},
		recordWatermark: () => watermark.get()?.position ?? 0,
		readRecordPage: (after, through, limit, checkBudget, workId) => {
			checkBudget?.()
			const rows: PositionedRecord[] = []
			try {
				const source =
					workId === undefined
						? recordPage.iterate(after, through, limit)
						: recordPageWork.iterate(workId, after, through, limit)
				for (const row of source) {
					checkBudget?.()
					rows.push(row)
				}
			} catch (error) {
				// The same Bun cursor-reset rule as the synchronous replay above.
				if (workId === undefined) recordPage.get(after, through, limit)
				else recordPageWork.get(workId, after, through, limit)
				throw error
			}
			return rows
		},
		hasProjectionOutput: (workId) =>
			readLog.all(workId, "plans").length > 0 || readLog.all(workId, "commits").length > 0,
		recordCount: (workId) => (workId ? (recordCountWork.get(workId)?.count ?? 0) : (recordCountAll.get()?.count ?? 0)),
		hasNote: (workId, name) => hasNote.get(workId, name) != null,
		getNote: (workId, name) => getNote.get(workId, name)?.body,
		putNote: (workId, name, body) => putNote.run(workId, name, body, Date.now()),
		deleteNote: (workId, name) => {
			deleteNote.run(workId, name)
		},
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
		deleteJournalCursor: (path) => {
			deleteCursor.run(path)
		},
		listJournalCursors: () => allCursors.all(),
		close: () => store.close(),
	}
}
