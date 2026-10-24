import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import type { WorkRecord } from "../../work-attribution/summary.js"
import { createMemoryRecords } from "./memory-records.js"
import {
	capture,
	closeBackends,
	ledgerHasWorkOutput,
	ledgerSessionInfo,
	readWorkHead,
	readWorkSummary,
	seedProjection,
	seedProjectionRows,
	useBackendFactory,
} from "./records.js"

/**
 * One scenario folded through BOTH the in-memory test backend and the real SQLite backend via the Bun
 * driver; identical observable results keep the test seam honest (Decision 9).
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const DRIVER = join(ROOT, "tests/e2e/tui/support/ledger-driver.ts")
const isBun = !!process.versions.bun

const WORK = "11111111-1111-4111-8111-111111111111"
const SESSION = "session-alpha"

const records: WorkRecord[] = [
	{
		version: 1,
		type: "work",
		workId: WORK,
		sessionId: SESSION,
		cwd: "/src/app",
		recordedAt: "2026-10-01T00:00:00.000Z",
	},
	{
		version: 1,
		type: "request",
		workId: WORK,
		sessionId: SESSION,
		requestId: "req-1",
		startedAt: "2026-10-01T00:01:00.000Z",
	},
	{
		version: 1,
		type: "plan",
		workId: WORK,
		sessionId: SESSION,
		path: ".plans/a.md",
		snapshotPath: ".plans/a.snap",
		recordedAt: "2026-10-01T00:02:00.000Z",
	},
	{
		version: 1,
		type: "commit",
		workId: WORK,
		sessionId: SESSION,
		sha: "a".repeat(40),
		repository: "/src/app/.git",
		worktree: "/src/app",
		recordedAt: "2026-10-01T00:03:00.000Z",
	},
	// Same request row key, later fields win; first-seen position is kept.
	{
		version: 1,
		type: "request_response",
		workId: WORK,
		sessionId: SESSION,
		requestId: "req-1",
		responseId: "resp-1",
		startedAt: "2026-10-01T00:04:00.000Z",
	},
]

function normalize(head: ReturnType<typeof readWorkHead>): unknown {
	if (!head) return head
	const { updatedAt: _updatedAt, ...rest } = head
	return rest
}

function expectScenario(head: unknown, view: ReturnType<typeof readWorkSummary>): void {
	expect(head).toMatchObject({
		version: 2,
		workId: WORK,
		latest: { plan: { recordedAt: "2026-10-01T00:02:00.000Z", snapshotPath: ".plans/a.snap" } },
		pullRequests: [],
	})
	expect(view?.sessions).toEqual([SESSION])
	expect(view?.requests).toHaveLength(1)
	// Later record wins on value: the response row's responseId is present.
	expect(view?.requests[0]).toMatchObject({ requestId: "req-1", responseId: "resp-1" })
	expect(view?.plans).toHaveLength(1)
	expect(view?.commits).toHaveLength(1)
}

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "kimchi-records-"))
}

describe("records conformance (memory backend)", () => {
	const dirs: string[] = []
	afterEach(() => {
		useBackendFactory(null)
		closeBackends()
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("capture folds records into the projection exactly like the legacy summary did", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		for (const record of records) capture(dir, record, "/ignored/source")
		expectScenario(normalize(readWorkHead(dir, WORK)), readWorkSummary(dir, WORK))
		expect(ledgerSessionInfo(dir, SESSION).work?.workId).toBe(WORK)
		expect(ledgerSessionInfo(dir, SESSION).recordCount).toBe(records.length)
		expect(ledgerHasWorkOutput(dir, WORK)).toBe(true)
	})

	it("capture writes zero files", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		for (const record of records) capture(dir, record, "/ignored/source")
		expect(readdirSyncSafe(dir)).toEqual([])
	})

	it("seedProjection and seedProjectionRows stand up the same snapshot shape digests expect", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		seedProjection(dir, WORK, { requestIds: ["req-x"] })
		expect(readWorkSummary(dir, WORK)?.requests).toHaveLength(1)
		seedProjectionRows(dir, {
			workId: WORK,
			sessions: [SESSION],
			workLinks: [],
			requests: [{ sessionId: SESSION, requestId: "req-y" }],
			plans: [],
			commits: [],
			fileTransitions: [],
			fileObservations: [],
			continuations: [],
		})
		const view = readWorkSummary(dir, WORK)
		expect(view?.requests.map((row) => row.requestId)).toEqual(["req-x", "req-y"])
	})

	it("dedupes by record hash: capturing the same record twice folds once", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		capture(dir, records[0], "/a")
		capture(dir, records[0], "/b")
		expect(ledgerSessionInfo(dir, SESSION).recordCount).toBe(1)
	})

	it("a failed transaction rolls back without keeping partial state", () => {
		const dir = agentDir()
		dirs.push(dir)
		const backend = createMemoryRecords()
		useBackendFactory(() => backend)
		capture(dir, records[0], "/a")
		const before = ledgerSessionInfo(dir, SESSION).recordCount
		let threw = false
		try {
			backend.tx(() => {
				backend.markDirty(WORK)
				throw new Error("boom")
			})
		} catch {
			threw = true
		}
		expect(threw).toBe(true)
		expect(backend.dirtyWorks()).toHaveLength(0)
		expect(ledgerSessionInfo(dir, SESSION).recordCount).toBe(before)
	})
})

function readdirSyncSafe(dir: string): string[] {
	try {
		return sumFiles(dir)
	} catch {
		return []
	}
	function sumFiles(current: string): string[] {
		const entries = readdirSync(current, { withFileTypes: true })
		const out: string[] = []
		for (const entry of entries) {
			const full = join(current, entry.name)
			if (entry.isDirectory()) out.push(...sumFiles(full))
			else if (entry.isFile()) out.push(full.slice(dir.length))
		}
		return out
	}
}

// Real SQLite parity + zero-file-writes + kill-safety: driven through the Bun helper because
// Node/vitest cannot load bun:sqlite.
function driver(...args: string[]): unknown {
	const stdout = execFileSync("bun", [DRIVER, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
}

describe("records conformance (SQLite via Bun driver)", { skip: isBun, timeout: 90_000 }, () => {
	it("capture folds identically to the memory backend and writes no legacy files", () => {
		const dir = agentDir()
		try {
			useBackendFactory(() => createMemoryRecords())
			const memDir = agentDir()
			for (const record of records) capture(memDir, record, "/ignored/source")
			const memHead = readWorkHead(memDir, WORK)
			const memView = readWorkSummary(memDir, WORK)
			closeBackends()
			rmSync(memDir, { recursive: true, force: true })

			for (const record of records) driver("capture", dir, JSON.stringify(record))
			const head = driver("head", dir, WORK) as ReturnType<typeof readWorkHead> | null
			const view = driver("rows", dir, WORK)
			// Both backends stamp a real timestamp; the rest of the head must match exactly.
			expect(typeof memHead?.updatedAt).toBe("string")
			expect(typeof head?.updatedAt).toBe("string")
			expect(normalize(head ?? undefined)).toEqual(normalize(memHead))
			expect(view).toEqual(memView)

			const files = driver("listfiles", dir) as string[]
			expect(files.filter((file) => !file.startsWith("pr-cost-reporting/ledger.db"))).toEqual([])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("SQLite dedups by record hash across processes", () => {
		const dir = agentDir()
		try {
			const first = driver("capture", dir, JSON.stringify(records[0])) as { captured: boolean; records: string }
			const again = driver("capture", dir, JSON.stringify(records[0])) as { captured: boolean; records: string }
			expect(first.captured).toBe(true)
			expect(again.captured).toBe(true)
			const head = driver("head", dir, WORK) as ReturnType<typeof readWorkHead> | null
			expect(head?.workId).toBe(WORK)
			expect(again.records).toBe("1")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("a killed writer leaves no partial transaction (WAL, FULL sync)", async () => {
		const dir = agentDir()
		try {
			driver("capture", dir, JSON.stringify(records[0]))
			const preHead = driver("head", dir, WORK)
			const preView = driver("rows", dir, WORK)
			const killer = spawn("bun", [DRIVER, "hold-writer", String(dir), "10000"], { cwd: ROOT })
			const killed = new Promise<number | null>((resolve, reject) =>
				killer.once("exit", (code) => resolve(code)).once("error", reject),
			)
			// Wait for the hold to start before killing it mid-transaction.
			let sawHold = false
			killer.stdout?.on("data", (chunk: Buffer) => {
				if (chunk.toString().includes('"held":true')) {
					sawHold = true
					killer.kill("SIGKILL")
				}
			})
			setTimeout(() => !sawHold && killer.kill("SIGKILL"), 5_000)
			await killed
			expect(sawHold).toBe(true)
			expect(driver("head", dir, WORK)).toEqual(preHead)
			expect(driver("rows", dir, WORK)).toEqual(preView)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

it("known regression: memory rollback restores records, projection and bookkeeping", () => {
	const dir = agentDir()
	const backend = createMemoryRecords()
	try {
		useBackendFactory(() => backend)
		for (const record of records.slice(0, 2)) capture(dir, record, "/ignored/source")
		backend.putNote(WORK, "rollback-probe", "before")
		const before = structuredClone(readWorkSummary(dir, WORK))
		expect(() =>
			backend.tx(() => {
				capture(dir, records[4], "/ignored/source")
				backend.putNote(WORK, "rollback-probe", "after")
				backend.markDirty(WORK)
				backend.diagnostic("rollback-probe")
				throw new Error("rollback-probe")
			}),
		).toThrow("rollback-probe")
		expect(ledgerSessionInfo(dir, SESSION).recordCount).toBe(2)
		expect(readWorkSummary(dir, WORK)).toEqual(before)
		expect(backend.getNote(WORK, "rollback-probe")).toBe("before")
		expect(backend.dirtyWorks()).toEqual([])
		capture(dir, records[4], "/ignored/source")
		expect(ledgerSessionInfo(dir, SESSION).recordCount).toBe(3)
		expect(readWorkSummary(dir, WORK)?.requests[0]).toMatchObject({ responseId: "resp-1" })
	} finally {
		useBackendFactory(null)
		closeBackends()
		rmSync(dir, { recursive: true, force: true })
	}
})

it("known regression: Bun preserves capture/update/reopen and rolls back failed writes", () => {
	const dir = agentDir()
	try {
		expect(driver("known-record-regressions", dir, JSON.stringify(records[0]))).toEqual({
			sessionWorkId: WORK,
			sessionRecords: 3,
			responseId: "regression-response",
			before: { authority: 3, markers: 3, heads: 1, rows: 2, notes: 0, dirty: 0, diagnostics: 0 },
			constraintRejected: true,
			afterConstraint: { authority: 3, markers: 3, heads: 1, rows: 2, notes: 0, dirty: 0, diagnostics: 0 },
			rolledBack: true,
			afterRollback: { authority: 3, markers: 3, heads: 1, rows: 2, notes: 0, dirty: 0, diagnostics: 0 },
			iteration: {
				aborted: true,
				budgetChecks: 3,
				sameConnectionRows: 3,
				sameConnectionUnchanged: true,
				transactionWrite: true,
				reopenedRows: 3,
				reopenedUnchanged: true,
				reopenedNote: true,
				noLegacyJournal: true,
			},
		})
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
