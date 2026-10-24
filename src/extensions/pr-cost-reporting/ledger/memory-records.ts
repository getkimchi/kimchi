import type { LogName, Row, WorkHead } from "../../work-attribution/row-log.js"
import type { JournalCursor, RecordBackend, StoredRecord } from "./records.js"

/**
 * Transient memory records backend for vitest: same visible behavior as the
 * SQLite backend, including rollback, so suite results carry over to Bun.
 */
type MemoryState = {
	readonly logs: Map<string, Map<LogName, Map<string, { pos: number; body: Row }>>>
	readonly heads: Map<string, WorkHead>
	readonly logsMeta: Map<string, { generation: number; bytes: number; rows: number }>
	readonly dirty: Set<string>
	readonly diagnostics: Map<string, number>
	readonly notes: Map<string, Map<string, string>>
	readonly records: Map<string, StoredRecord>
	readonly order: StoredRecord[]
	readonly cursors: Map<string, JournalCursor>
	readonly counters: { pos: Map<string, number>; diagnosticsVersion: number }
}

function freshMemoryState(): MemoryState {
	return {
		logs: new Map(),
		heads: new Map(),
		logsMeta: new Map(),
		dirty: new Set(),
		diagnostics: new Map(),
		notes: new Map(),
		records: new Map(),
		order: [],
		cursors: new Map(),
		counters: { pos: new Map(), diagnosticsVersion: 0 },
	}
}

/** The in-memory RecordBackend used by vitest: identical semantics to the SQLite one, over plain Maps. The shared
 * conformance suite runs the same scenario against both, so this double cannot drift from production behavior. */
export function createMemoryRecords(): RecordBackend {
	const records = new Map<string, StoredRecord>()
	const order: StoredRecord[] = []
	const logs = new Map<string, Map<LogName, Map<string, { pos: number; body: Row }>>>()
	const positions = new Map<string, number>()
	const heads = new Map<string, WorkHead>()
	const markers = new Map<string, { workId: string; type: string }>()
	const dirty = new Set<string>()
	const notes = new Map<string, string>()
	const diagnostics = new Map<string, number>()
	const cursors = new Map<string, JournalCursor>()
	const noteKey = (workId: string, name: string) => `${workId}\u0000${name}`
	const logKey = (workId: string, log: LogName) => `${workId}\u0000${log}`
	let inTx = false

	const workLogs = (workId: string): Map<LogName, Map<string, { pos: number; body: Row }>> => {
		let found = logs.get(workId)
		if (!found) {
			found = new Map()
			logs.set(workId, found)
		}
		return found
	}

	const restore = (backup: {
		records: [string, StoredRecord][]
		order: StoredRecord[]
		logs: [string, Map<LogName, Map<string, { pos: number; body: Row }>>][]
		positions: [string, number][]
		heads: [string, WorkHead][]
		markers: [string, { workId: string; type: string }][]
		dirty: string[]
		notes: [string, string][]
		diagnostics: [string, number][]
		cursors: [string, JournalCursor][]
	}): void => {
		records.clear()
		for (const [key, value] of backup.records) records.set(key, value)
		order.length = 0
		order.push(...backup.order)
		logs.clear()
		for (const [key, value] of backup.logs) logs.set(key, value)
		positions.clear()
		for (const [key, value] of backup.positions) positions.set(key, value)
		heads.clear()
		for (const [key, value] of backup.heads) heads.set(key, value)
		markers.clear()
		for (const [key, value] of backup.markers) markers.set(key, value)
		dirty.clear()
		for (const value of backup.dirty) dirty.add(value)
		notes.clear()
		for (const [key, value] of backup.notes) notes.set(key, value)
		diagnostics.clear()
		for (const [key, value] of backup.diagnostics) diagnostics.set(key, value)
		cursors.clear()
		for (const [key, value] of backup.cursors) cursors.set(key, value)
		headPositions.clear()
		headVersions.clear()
	}

	// headPositions mimics legacy work.json manifest state for behaviors needing it.
	const headPositions = new Map<string, number>()
	const headVersions = new Map<string, number>()

	return {
		/**
		 * In-memory transaction: attach a deep snapshot at entry and restore it on throw so mixed
		 * mutation-then-failure paths cannot leak partial writes — same contract as the SQLite backend.
		 */
		tx: <T>(fn: () => T): T => {
			if (inTx) return fn()
			inTx = true
			const backup = {
				records: structuredClone([...records]),
				order: structuredClone(order),
				logs: structuredClone([...logs]),
				positions: [...positions],
				heads: structuredClone([...heads]),
				markers: structuredClone([...markers]),
				dirty: [...dirty],
				notes: structuredClone([...notes]),
				diagnostics: [...diagnostics],
				cursors: structuredClone([...cursors]),
			}
			try {
				const result = fn()
				inTx = false
				return result
			} catch (error) {
				restore(backup)
				inTx = false
				throw error
			}
		},
		insertRecord: (row) => {
			if (records.has(row.recordHash)) return false
			records.set(row.recordHash, row)
			order.push(row)
			return true
		},
		upsertMarker: (recordHash, workId, type) => markers.set(recordHash, { workId, type }),
		markDirty: (workId) => dirty.add(workId),
		clearDirty: (workId) => dirty.delete(workId),
		dirtyWorks: () => [...dirty],
		getRow: (workId, log, key) => workLogs(workId).get(log)?.get(key)?.body,
		putRow: (workId, log, key, body) => {
			const byLog = workLogs(workId)
			let byKey = byLog.get(log)
			if (!byKey) {
				byKey = new Map()
				byLog.set(log, byKey)
			}
			const existing = byKey.get(key)
			if (existing) existing.body = body
			else {
				const position = (positions.get(logKey(workId, log)) ?? 0) + 1
				positions.set(logKey(workId, log), position)
				byKey.set(key, { pos: position, body })
			}
		},
		readLog: (workId, log) =>
			[...(workLogs(workId).get(log)?.values() ?? [])]
				.sort((left, right) => left.pos - right.pos)
				.map((entry) => entry.body),
		clearProjection: (workId) => {
			logs.delete(workId)
			heads.delete(workId)
			for (const log of [...(workLogs(workId).keys() ?? [])]) positions.delete(logKey(workId, log))
		},
		getHead: (workId) => heads.get(workId),
		putHead: (head) => heads.set(head.workId, head),
		allHeads: () => [...heads.values()],
		readRecords: (opts, checkBudget) =>
			order.filter((row) => {
				checkBudget?.()
				return (
					(opts.workId === undefined || row.workId === opts.workId) &&
					(opts.sessionId === undefined || row.sessionId === opts.sessionId) &&
					(opts.modifiedSince === undefined || row.importedAt >= opts.modifiedSince)
				)
			}),
		recordWatermark: () => order.length,
		readRecordPage: (after, through, limit, checkBudget) =>
			order.slice(after, Math.min(through, after + limit)).map((row, index) => {
				checkBudget?.()
				return { ...row, position: after + index + 1 }
			}),
		recordCount: (workId) => (workId ? order.filter((row) => row.workId === workId).length : order.length),
		hasProjectionOutput: (workId) => {
			const byLog = logs.get(workId)
			return (byLog?.get("plans")?.size ?? 0) > 0 || (byLog?.get("commits")?.size ?? 0) > 0
		},
		hasNote: (workId, name) => notes.has(noteKey(workId, name)),
		getNote: (workId, name) => notes.get(noteKey(workId, name)),
		putNote: (workId, name, body) => notes.set(noteKey(workId, name), body),
		diagnostic: (code) => diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1),
		getJournalCursor: (path) => cursors.get(path),
		putJournalCursor: (cursor) => cursors.set(cursor.path, { ...cursor }),
		listJournalCursors: () => [...cursors.values()],
		close: () => {},
	}
}

/** Alias kept for suites that referenced the earlier draft name. */
export const createInMemoryRecords = createMemoryRecords
