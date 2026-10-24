import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { backendFor } from "../pr-cost-reporting/ledger/records.js"
import { pinWorkContinuation, readContinuationHistory } from "./links.js"
import { readWorkRecords, type WorkRecordProblem } from "./summary.js"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof fs>()) }))

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

const work = { version: 1, type: "work", workId: WORK, sessionId: "legacy", cwd: "/src/app" }

afterEach(() => {
	vi.restoreAllMocks()
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
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
