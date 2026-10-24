import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import * as fileSystem from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { backendFor, capture } from "../pr-cost-reporting/ledger/records.js"
import { pinWorkContinuation, readContinuationHistory } from "./links.js"
import {
	readWorkRecords,
	readWorkRecordsAsync,
	type WorkRecord,
	type WorkRecordProblem,
	workJournalFingerprint,
} from "./summary.js"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fileSystem>()) }))

const WORK = "11111111-1111-4111-8111-111111111111"
const directories: string[] = []

function journal(lines: unknown[]) {
	const agentDir = mkdtempSync(join(tmpdir(), "kimchi-history-reader-"))
	directories.push(agentDir)
	const directory = join(agentDir, "work-attribution")
	mkdirSync(directory)
	const path = join(directory, "legacy.jsonl")
	writeFileSync(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`)
	return { agentDir, path }
}

const work: WorkRecord = { version: 1, type: "work", workId: WORK, sessionId: "legacy", cwd: "/src/app" }

afterEach(() => {
	vi.restoreAllMocks()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it("aborts fingerprinting when cancellation arrives during a real legacy stat", async () => {
	const { agentDir, path } = journal([work])
	writeFileSync(
		join(agentDir, "work-attribution", "second.jsonl"),
		`${JSON.stringify({ ...work, sessionId: "later" })}\n`,
	)
	const controller = new AbortController()
	const failure = new Error("legacy stat aborted")
	const original = fileSystem.stat
	const stats = vi.spyOn(fileSystem, "stat").mockImplementationOnce(async () => {
		const value = await original(path, { bigint: true })
		controller.abort(failure)
		return value
	})
	await expect(workJournalFingerprint(agentDir, () => controller.signal.throwIfAborted())).rejects.toBe(failure)
	expect(stats).toHaveBeenCalledOnce()
})

it("fingerprints a same-size middle rewrite when modification time is restored", async () => {
	const trailing = { ...work, sessionId: "unchanged-tail" }
	const { agentDir, path } = journal([work, trailing])
	const time = new Date("2026-10-01T00:00:00Z")
	fs.utimesSync(path, time, time)
	const before = fs.statSync(path, { bigint: true })
	const fingerprint = await workJournalFingerprint(agentDir)
	writeFileSync(path, `${JSON.stringify({ ...work, cwd: "/src/apt" })}\n${JSON.stringify(trailing)}\n`)
	fs.utimesSync(path, time, time)
	const after = fs.statSync(path, { bigint: true })
	expect([after.dev, after.ino, after.size, after.mtimeNs]).toEqual([
		before.dev,
		before.ino,
		before.size,
		before.mtimeNs,
	])
	expect(after.ctimeNs).not.toBe(before.ctimeNs)
	expect(await workJournalFingerprint(agentDir)).not.toBe(fingerprint)
})

it("reports consumed malformed and unknown-type history on every read, not just the import pass", () => {
	const unknown = { ...work, type: "future_retraction", requestId: "original-request" }
	const { agentDir, path } = journal([work, "not json{{{", unknown])
	// A caller that does not request diagnostics must not consume and lose them for the next caller.
	expect(readWorkRecords(agentDir)).toEqual([work])
	for (let attempt = 0; attempt < 2; attempt++) {
		const problems: WorkRecordProblem[] = []
		expect(readWorkRecords(agentDir, undefined, undefined, (problem) => problems.push(problem))).toEqual([work])
		expect(problems).toEqual([
			{ kind: "invalid", path, line: 2 },
			{ kind: "unknown-type", path, line: 3, record: unknown },
		])
		expect(() => readContinuationHistory(agentDir)).toThrow("Incomplete work history contains invalid records")
	}
})

it("honors a read budget before import commits and allows a later retry", () => {
	const { agentDir, path } = journal([work])
	const budget = () => {
		throw new Error("history budget exhausted")
	}
	expect(() => readWorkRecords(agentDir, undefined, budget)).toThrow("history budget exhausted")
	expect(backendFor(agentDir).getJournalCursor(path)).toBeUndefined()
	expect(backendFor(agentDir).recordCount()).toBe(0)
	expect(readWorkRecords(agentDir)).toEqual([work])
	expect(() => readWorkRecords(agentDir, undefined, budget)).toThrow("history budget exhausted")
})

it("aborts between committed import batches and resumes without losing or duplicating authority", async () => {
	const requests = Array.from({ length: 1500 }, (_, index) => ({
		...work,
		type: "request",
		requestId: `async-${index}`,
		scope: null,
		padding: "x".repeat(1024),
	}))
	const { agentDir, path } = journal([work, ...requests])
	const bytes = fs.readFileSync(path, "utf8")
	const backend = backendFor(agentDir)
	const controller = new AbortController()
	const putCursor = backend.putJournalCursor.bind(backend)
	const cursor = vi.spyOn(backend, "putJournalCursor").mockImplementation((value) => {
		putCursor(value)
		setImmediate(() => controller.abort(new Error("history reader closed")))
	})
	await expect(readWorkRecordsAsync(agentDir, controller.signal)).rejects.toThrow("history reader closed")
	const authority = backend.readRecords({ workId: WORK })
	expect(authority.length).toBeGreaterThan(0)
	expect(authority.length).toBeLessThan(requests.length + 1)
	expect(backend.getJournalCursor(path)?.offset).toBeLessThan(Buffer.byteLength(bytes))
	cursor.mockRestore()
	expect(await readWorkRecordsAsync(agentDir, new AbortController().signal)).toEqual([work, ...requests])
	expect(backend.readRecords({ workId: WORK }).slice(0, authority.length)).toEqual(authority)
	expect(backend.recordCount()).toBe(requests.length + 1)
	expect(fs.readFileSync(path, "utf8")).toBe(bytes)
})

it("rolls coverage back with authority and cursor when the cursor write fails", () => {
	const { agentDir, path } = journal([work, "not json{{{"])
	const backend = backendFor(agentDir)
	const cursor = vi.spyOn(backend, "putJournalCursor").mockImplementationOnce(() => {
		throw new Error("cursor unavailable")
	})
	expect(() => readWorkRecords(agentDir, undefined, undefined, () => {})).toThrow("cursor unavailable")
	expect(backend.getJournalCursor(path)).toBeUndefined()
	expect(backend.getNote("journal-coverage", path)).toBeUndefined()
	expect(backend.recordCount()).toBe(0)
	expect(backend.getHead(WORK)).toBeUndefined()
	cursor.mockRestore()
	const problems: WorkRecordProblem[] = []
	expect(readWorkRecords(agentDir, undefined, undefined, (problem) => problems.push(problem))).toEqual([work])
	expect(problems).toEqual([{ kind: "invalid", path, line: 2 }])
})

it("retains absolute line numbers when damage arrives after a consumed prefix", () => {
	const { agentDir, path } = journal([work])
	expect(readWorkRecords(agentDir)).toEqual([work])
	appendFileSync(path, "\nnot json{{{\n")
	const problems: WorkRecordProblem[] = []
	readWorkRecords(agentDir, undefined, undefined, (problem) => problems.push(problem))
	expect(problems).toEqual([{ kind: "invalid", path, line: 3 }])
})

it("keeps imported authority and incomplete coverage after a source is rewritten or removed", () => {
	const { agentDir, path } = journal([work])
	expect(readWorkRecords(agentDir)).toEqual([work])
	writeFileSync(path, "")
	for (let attempt = 0; attempt < 2; attempt++) {
		const problems: WorkRecordProblem[] = []
		expect(readWorkRecords(agentDir, undefined, undefined, (problem) => problems.push(problem))).toEqual([work])
		expect(problems).toEqual([{ kind: "invalid", path, line: 1 }])
		if (attempt === 0) unlinkSync(path)
	}
})

it("propagates budget interruption during stored-row replay instead of treating it as damaged JSON", () => {
	const { agentDir } = journal([work])
	readWorkRecords(agentDir)
	const backend = backendFor(agentDir)
	const original = backend.readRecords.bind(backend)
	let replaying = false
	vi.spyOn(backend, "readRecords").mockImplementation((options) => {
		replaying = true
		return original(options)
	})
	expect(() =>
		readWorkRecords(agentDir, undefined, () => {
			if (replaying) throw new Error("replay budget exhausted")
		}),
	).toThrow("replay budget exhausted")
})

it("replays consumed unknown-type coverage after a real SQLite process restart", () => {
	const unknown = { ...work, type: "future_retraction", requestId: "original-request" }
	const { agentDir, path } = journal([work, unknown])
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const run = (command: string) =>
		JSON.parse(execFileSync("bun", [driver, command, agentDir], { encoding: "utf8", timeout: 30_000 }).trim())
	expect(run("read-work-records")).toEqual([work])
	for (let attempt = 0; attempt < 2; attempt++) {
		expect(run("read-history")).toEqual({
			records: [work],
			problems: [{ kind: "unknown-type", path, line: 2, record: unknown }],
		})
	}
}, 30_000)

it("pins asynchronous replay to its starting watermark without materializing the whole store", async () => {
	const requests = Array.from({ length: 260 }, (_, index) => ({
		...work,
		type: "request",
		requestId: `watermark-${index}`,
	}))
	const { agentDir } = journal([work, ...requests])
	readWorkRecords(agentDir)
	const backend = backendFor(agentDir)
	const page = backend.readRecordPage.bind(backend)
	const later: WorkRecord = { ...work, type: "request", requestId: "captured-between-pages" }
	vi.spyOn(backend, "readRecordPage").mockImplementation((after, through, limit, checkBudget) => {
		const rows = page(after, through, limit, checkBudget)
		if (after === 0) setImmediate(() => capture(agentDir, later, null))
		return rows
	})
	const unbounded = vi.spyOn(backend, "readRecords").mockImplementation(() => {
		throw new Error("Unbounded native history materialization")
	})
	expect(await readWorkRecordsAsync(agentDir, new AbortController().signal)).toEqual([work, ...requests])
	vi.mocked(backend.readRecordPage).mockRestore()
	expect(await readWorkRecordsAsync(agentDir, new AbortController().signal)).toEqual([work, ...requests, later])
	expect(unbounded).not.toHaveBeenCalled()
})

it("cancels from inside actual native SQLite row reading and preserves same-connection and reopened history", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "kimchi-native-async-reader-"))
	directories.push(agentDir)
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const result = JSON.parse(
		execFileSync("bun", [driver, "known-async-read-regressions", agentDir, JSON.stringify(work)], {
			encoding: "utf8",
			timeout: 30_000,
		}).trim(),
	)
	expect(result).toMatchObject({
		observerEntered: true,
		callbackRan: true,
		cancelled: true,
		nativeRows: 1025,
		sameConnectionComplete: true,
		captureCommitted: true,
		reopenedComplete: true,
		noLegacyJournal: true,
		snapshotComplete: true,
		nextReadSeesCapture: true,
	})
	expect(result.rowsAtAbort).toBeGreaterThan(0)
	expect(result.rowsAtAbort).toBeLessThan(result.nativeRows)
}, 30_000)

it("yields while importing real SQLite history and replays coverage after process restart", () => {
	const requests = Array.from({ length: 1500 }, (_, index) => ({
		...work,
		type: "request",
		requestId: `async-${index}`,
		scope: null,
		padding: "x".repeat(1024),
	}))
	const unknown = { ...work, type: "future_retraction", requestId: "original-request" }
	const { agentDir, path } = journal([work, ...requests, unknown])
	const bytes = fs.readFileSync(path, "utf8")
	const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
	const run = () =>
		JSON.parse(
			execFileSync("bun", [driver, "read-history-async", agentDir], { encoding: "utf8", timeout: 30_000 }).trim(),
		)
	const expected = {
		records: requests.length + 1,
		requestIds: requests.map((row) => row.requestId),
		problems: [{ kind: "unknown-type", path, line: requests.length + 2, record: unknown }],
	}
	const imported = run()
	expect(imported).toMatchObject(expected)
	expect(imported.turns).toBeGreaterThanOrEqual(3)
	expect(run()).toMatchObject(expected)
	expect(fs.readFileSync(path, "utf8")).toBe(bytes)
}, 30_000)

it("repairs a truncated EOF diagnostic after a later complete line without clearing unknown records", () => {
	const request = { ...work, type: "request", requestId: "later-request" }
	const unknown = { ...work, type: "future_retraction" }
	const { agentDir, path } = journal([work, '{"version":1,"type":"work_link",'])
	expect(() => readContinuationHistory(agentDir)).toThrow("Incomplete work history contains invalid records")
	appendFileSync(path, `${JSON.stringify(request)}\n`)
	expect(readContinuationHistory(agentDir).records).toEqual([work, request])
	appendFileSync(path, `${JSON.stringify(unknown)}\n${JSON.stringify(request)}\n`)
	const history = readContinuationHistory(agentDir)
	expect(() =>
		pinWorkContinuation({ workId: WORK, source: "saved-plan", evidence: { path: "/plan.md" } }, history),
	).toThrow("Work history contains unknown record types")
})

it("interrupts preparation of an unchanged large prefix without advancing its cursor", () => {
	const { agentDir, path } = journal([{ ...work, padding: "x".repeat(160 * 1024) }])
	readWorkRecords(agentDir)
	const backend = backendFor(agentDir)
	const cursor = backend.getJournalCursor(path)
	let chunks = 0
	const read = fs.readSync
	const chunk = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
		chunks++
		return read(...args)
	})
	expect(() =>
		readWorkRecords(agentDir, undefined, () => {
			if (chunks) throw new Error("preparation budget exhausted")
		}),
	).toThrow("preparation budget exhausted")
	expect(chunks).toBe(1)
	expect(backend.getJournalCursor(path)).toEqual(cursor)
	expect(backend.recordCount()).toBe(1)
	chunk.mockRestore()
	expect(readWorkRecords(agentDir)).toHaveLength(1)
})
