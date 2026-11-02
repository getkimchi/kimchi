import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { calculatePullRequestCosts } from "../work-attribution/costs.js"
import type { WorkRecord } from "../work-attribution/summary.js"
import type { CommonEvents } from "./events.js"
import { groupKey, prepareGroupCache, readChangedGroup, requestIndexEntries, saveGroupCache } from "./incremental.js"
import { createMemoryRecords } from "./ledger/memory-records.js"
import type { StoredRecord } from "./ledger/records.js"

const workId = "22222222-2222-4222-8222-222222222222"
const producer = "33333333-3333-4333-8333-333333333333"

it("persists and validates large structural context without storing full bodies", () => {
	const rows: WorkRecord[] = Array.from({ length: 700 }, (_, index) => ({
		version: 1,
		type: "commit",
		workId,
		sessionId: "testOrg-session",
		recordedAt: "2026-10-24T08:00:00.000Z",
		repository: "/testOrg/widgets/.git",
		worktree: "/testOrg/widgets",
		sha: index.toString(16).padStart(40, "0"),
		message: "testOrg-change-".repeat(90),
	}))
	const stored: StoredRecord[] = rows.map((row, index) => {
		const body = JSON.stringify(row)
		return {
			recordHash: createHash("sha256").update(`${index}\0${body}`).digest("hex"),
			type: row.type,
			workId: row.workId,
			sessionId: row.sessionId,
			body,
			sourcePath: null,
			sourceGeneration: 0,
			sourceOffset: null,
			importedAt: 0,
		}
	})
	const backend = createMemoryRecords()
	for (const row of stored) backend.insertRecord(row)
	const built: CommonEvents = { accounts: [], units: [], unresolved: [] }
	const cache = prepareGroupCache(
		backend,
		[workId],
		producer,
		backend.recordWatermark(),
		stored,
		rows,
		new Map(),
		built,
	)
	expect(cache).toBeDefined()
	if (!cache) return
	saveGroupCache(backend, cache)
	const saved = backend.getNote("agent", groupKey([workId]))
	expect(saved).toBeDefined()
	if (!saved) return
	expect(Buffer.byteLength(saved)).toBeLessThan(256 * 1024)
	const compact = JSON.parse(JSON.parse(saved).body)
	expect(compact.context[0]).toEqual([stored[0].recordHash, createHash("sha256").update(stored[0].body).digest("hex")])
	expect(readChangedGroup(backend, [workId], producer, new Map(), () => {})?.cache.context).toEqual(stored)
	const getRecord = backend.getRecord
	backend.getRecord = (hash) => {
		const row = getRecord(hash)
		return row && hash === stored[0].recordHash ? { ...row, body: "{}" } : row
	}
	expect(readChangedGroup(backend, [workId], producer, new Map(), () => {})).toBeUndefined()
})

it("retains native segment evidence across partial index updates", () => {
	const requestId = "44444444-4444-4444-8444-444444444444"
	const request: WorkRecord = {
		version: 1,
		type: "request",
		workId,
		sessionId: "testOrg-session",
		recordedAt: "2026-10-24T08:00:00.000Z",
		requestId,
		segment: { id: "99999999-9999-4999-8999-000000000003", attribution: "session", reason: "matching-disabled" },
	}
	const native: WorkRecord = {
		version: 1,
		type: "commit",
		workId,
		sessionId: "testOrg-session",
		recordedAt: "2026-10-24T08:00:01.000Z",
		requestId,
		repository: "/testOrg/widgets/.git",
		worktree: "/testOrg/widgets",
		sha: "a".repeat(40),
	}
	const stored: StoredRecord[] = [request, native].map((row) => {
		const body = JSON.stringify(row)
		return {
			recordHash: createHash("sha256").update(body).digest("hex"),
			type: row.type,
			workId,
			sessionId: row.sessionId,
			body,
			sourcePath: null,
			sourceGeneration: 0,
			sourceOffset: null,
			importedAt: 0,
		}
	})
	const backend = createMemoryRecords()
	const report = calculatePullRequestCosts([], [])
	const safe = requestIndexEntries(stored.slice(0, 1), [request], report, { kind: "complete" }).find((entry) =>
		entry.name.includes(":segment:"),
	)
	expect(safe?.body).toBe("0")
	if (!safe) return
	const guarded = requestIndexEntries(stored, [request, native], report, { kind: "complete" }).find(
		(entry) => entry.name === safe.name,
	)
	expect(guarded?.body).toBe("1")
	backend.putNote(safe.owner, safe.name, "1")
	const partial = requestIndexEntries(stored.slice(0, 1), [request], report, { kind: "partial", backend }).find(
		(entry) => entry.name === safe.name,
	)
	expect(partial?.body).toBe("1")
	backend.putNote(safe.owner, safe.name, "legacy")
	expect(
		requestIndexEntries(stored.slice(0, 1), [request], report, { kind: "partial", backend }).find(
			(entry) => entry.name === safe.name,
		)?.body,
	).toBe("1")
})

it("rejects oversized structural context before reading any body", () => {
	const rows: WorkRecord[] = Array.from({ length: 2049 }, (_, index) => ({
		version: 1,
		type: "commit",
		workId,
		sessionId: "testOrg-session",
		recordedAt: "2026-10-24T08:00:00.000Z",
		repository: "/testOrg/widgets/.git",
		worktree: "/testOrg/widgets",
		sha: index.toString(16).padStart(40, "0"),
	}))
	const stored: StoredRecord[] = rows.map((row, index) => ({
		recordHash: index.toString(16).padStart(64, "0"),
		type: row.type,
		workId,
		sessionId: row.sessionId,
		get body(): string {
			throw new Error("oversized context must not be hashed")
		},
		sourcePath: null,
		sourceGeneration: 0,
		sourceOffset: null,
		importedAt: 0,
	}))
	const backend = createMemoryRecords()
	const built: CommonEvents = { accounts: [], units: [], unresolved: [] }
	expect(prepareGroupCache(backend, [workId], producer, 0, stored, rows, new Map(), built)).toBeUndefined()
})
