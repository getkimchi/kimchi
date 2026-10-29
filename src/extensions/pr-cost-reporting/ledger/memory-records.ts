import type { LogName, Row, WorkHead } from "../../work-attribution/row-log.js"
import type {
	JournalCursor,
	OutboxAccountStatus,
	OutboxBatch,
	OutboxEvent,
	RecordBackend,
	StoredRecord,
} from "./records.js"

/** The in-memory RecordBackend used by vitest: identical semantics to the SQLite one, over plain Maps. The shared
 * conformance suite runs the same scenario against both, so this double cannot drift from production behavior. */
export function createMemoryRecords(): RecordBackend {
	const records = new Map<string, StoredRecord>()
	const order: StoredRecord[] = []
	const logs = new Map<string, Map<LogName, Map<string, { pos: number; body: Row }>>>()
	const heads = new Map<string, WorkHead>()
	const markers = new Map<string, { workId: string; type: string }>()
	const dirty = new Set<string>()
	const notes = new Map<string, string>()
	const diagnostics = new Map<string, number>()
	const cursors = new Map<string, JournalCursor>()
	const events = new Map<string, OutboxEvent>()
	const batches = new Map<string, OutboxBatch>()
	const noteKey = (workId: string, name: string) => `${workId}\u0000${name}`
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
		heads: [string, WorkHead][]
		markers: [string, { workId: string; type: string }][]
		dirty: string[]
		notes: [string, string][]
		diagnostics: [string, number][]
		cursors: [string, JournalCursor][]
		events: [string, OutboxEvent][]
		batches: [string, OutboxBatch][]
	}): void => {
		records.clear()
		for (const [key, value] of backup.records) records.set(key, value)
		order.length = 0
		order.push(...backup.order)
		logs.clear()
		for (const [key, value] of backup.logs) logs.set(key, value)
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
		events.clear()
		for (const [key, value] of backup.events) events.set(key, value)
		batches.clear()
		for (const [key, value] of backup.batches) batches.set(key, value)
	}

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
				heads: structuredClone([...heads]),
				markers: structuredClone([...markers]),
				dirty: [...dirty],
				notes: structuredClone([...notes]),
				diagnostics: [...diagnostics],
				cursors: structuredClone([...cursors]),
				events: structuredClone([...events]),
				batches: structuredClone([...batches]),
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
		pendingTranslations: (after, through, limit) =>
			order
				.slice(after, through)
				.map((row, index) => ({ ...row, position: after + index + 1 }))
				.filter((row) => markers.has(row.recordHash))
				.slice(0, limit),
		clearTranslation: (recordHash) => markers.delete(recordHash),
		markedRecords: () => [...markers].map(([recordHash, { workId, type }]) => ({ recordHash, workId, type })),
		latestOutboxEvent: (accountKey, entityId) =>
			structuredClone(
				[...events.values()].findLast(
					(event) => event.accountKey === accountKey && event.entityId === entityId && event.blocked === "",
				),
			),
		getOutboxEvent: (accountKey, id) => {
			const event = events.get(id)
			return event?.accountKey === accountKey ? structuredClone(event) : undefined
		},
		outboxEntityEvents: (accountKey, entityId) =>
			structuredClone(
				[...events.values()].filter((event) => event.accountKey === accountKey && event.entityId === entityId),
			),
		unblockedOutboxEventCount: (accountKey, entityId) =>
			[...events.values()].filter(
				(event) => event.accountKey === accountKey && event.entityId === entityId && event.blocked === "",
			).length,
		insertOutboxEvent: (event) => {
			if (events.has(event.id)) throw new Error("Duplicate outbox event")
			events.set(event.id, structuredClone(event))
		},
		pendingOutboxEvents: (accountKey, limit) =>
			structuredClone(
				[...events.values()]
					.filter((event) => event.accountKey === accountKey && event.ackedAt === null && event.blocked === "")
					.slice(0, limit),
			),
		outboxStatus: () => {
			const accounts = new Map<string, OutboxAccountStatus>()
			const account = (accountKey: string) => {
				let status = accounts.get(accountKey)
				if (!status) {
					status = {
						accountKey,
						pending: 0,
						sendable: 0,
						blocked: 0,
						acknowledged: 0,
						lastAcknowledgedAt: null,
						batches: 0,
						firstBatchId: null,
					}
					accounts.set(accountKey, status)
				}
				return status
			}
			for (const event of events.values()) {
				const status = account(event.accountKey)
				if (event.ackedAt === null) {
					status.pending++
					if (event.blocked) status.blocked++
					else status.sendable++
				} else {
					status.acknowledged++
					status.lastAcknowledgedAt = Math.max(status.lastAcknowledgedAt ?? 0, event.ackedAt)
				}
			}
			for (const batch of [...batches.values()].sort(
				(a, b) => Buffer.compare(Buffer.from(a.orderKey), Buffer.from(b.orderKey)) || a.createdAt - b.createdAt,
			)) {
				const status = account(batch.accountKey)
				status.batches++
				status.firstBatchId ??= batch.id
			}
			return [...accounts.values()].sort((a, b) => Buffer.compare(Buffer.from(a.accountKey), Buffer.from(b.accountKey)))
		},
		getOutboxBatch: (accountKey) =>
			structuredClone(
				[...batches.values()]
					.filter((batch) => batch.accountKey === accountKey)
					.sort(
						(a, b) => Buffer.compare(Buffer.from(a.orderKey), Buffer.from(b.orderKey)) || a.createdAt - b.createdAt,
					)[0],
			),
		insertOutboxBatch: (batch) => {
			if (batches.has(batch.id)) throw new Error("Duplicate outbox batch")
			batches.set(batch.id, structuredClone(batch))
		},
		ackOutboxEvent: (accountKey, id, hash, at) => {
			const event = events.get(id)
			if (!event || event.accountKey !== accountKey || event.hash !== hash || event.ackedAt !== null) return false
			event.ackedAt = at
			return true
		},
		blockOutboxEvent: (accountKey, id, hash, reason) => {
			const event = events.get(id)
			if (!event || event.accountKey !== accountKey || event.hash !== hash || event.ackedAt !== null || event.blocked)
				return false
			event.blocked = reason
			return true
		},
		deleteOutboxBatch: (accountKey, id) => batches.get(id)?.accountKey === accountKey && batches.delete(id),
		markDirty: (workId) => dirty.add(workId),
		clearDirty: (workId) => dirty.delete(workId),
		dirtyWorks: () => [...dirty],
		getRow: (workId, log, key) => workLogs(workId).get(log)?.get(key)?.body,
		putRow: (workId, log, key, body, pos) => {
			const byLog = workLogs(workId)
			let byKey = byLog.get(log)
			if (!byKey) {
				byKey = new Map()
				byLog.set(log, byKey)
			}
			const existing = byKey.get(key)
			if (existing) existing.body = body
			else byKey.set(key, { pos, body })
		},
		readLog: (workId, log) =>
			[...(workLogs(workId).get(log)?.values() ?? [])]
				.sort((left, right) => left.pos - right.pos)
				.map((entry) => entry.body),
		clearProjection: (workId) => {
			logs.delete(workId)
			heads.delete(workId)
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
					(opts.type === undefined || row.type === opts.type) &&
					(opts.modifiedSince === undefined || row.importedAt >= opts.modifiedSince)
				)
			}),
		recordWatermark: () => order.length,
		readRecordPage: (after, through, limit, checkBudget, workId) => {
			const page: ReturnType<RecordBackend["readRecordPage"]> = []
			for (let index = after; index < Math.min(through, order.length) && page.length < limit; index++) {
				checkBudget?.()
				const row = order[index]
				if (workId === undefined || row.workId === workId) page.push({ ...row, position: index + 1 })
			}
			return page
		},
		recordCount: (workId) => (workId ? order.filter((row) => row.workId === workId).length : order.length),
		hasProjectionOutput: (workId) => {
			const byLog = logs.get(workId)
			return (byLog?.get("plans")?.size ?? 0) > 0 || (byLog?.get("commits")?.size ?? 0) > 0
		},
		hasNote: (workId, name) => notes.has(noteKey(workId, name)),
		getNote: (workId, name) => notes.get(noteKey(workId, name)),
		putNote: (workId, name, body) => notes.set(noteKey(workId, name), body),
		deleteNote: (workId, name) => {
			notes.delete(noteKey(workId, name))
		},
		diagnostic: (code) => diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1),
		getJournalCursor: (path) => cursors.get(path),
		putJournalCursor: (cursor) => cursors.set(cursor.path, { ...cursor }),
		deleteJournalCursor: (path) => {
			cursors.delete(path)
		},
		listJournalCursors: () => [...cursors.values()],
		close: () => {},
	}
}
