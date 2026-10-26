import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
	boundaryHashOf,
	completeLines,
	hydrateLegacy,
	hydrateLegacyOnce,
	importJournals,
	journalDecision,
} from "./import.js"
import { createMemoryRecords } from "./memory-records.js"
import { capture, closeBackends, type JournalCursor, readRecords, readWorkRows, useBackendFactory } from "./records.js"

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const DRIVER = join(ROOT, "tests/e2e/tui/support/ledger-driver.ts")
const isBun = !!process.versions.bun

const WORK = "11111111-1111-4111-8111-111111111111"
const SESSION = "session-import"

function agentDir(): string {
	return mkdtempSync(join(tmpdir(), "kimchi-import-"))
}

function line(record: Record<string, unknown>): string {
	return JSON.stringify(record) + "\n"
}

function journal(file: string): string {
	const path = join(file, "work-attribution")
	mkdirSync(path, { recursive: true })
	return path
}

const work = (): Record<string, unknown> => ({
	version: 1,
	type: "work",
	workId: WORK,
	sessionId: SESSION,
	cwd: "/src/app",
	recordedAt: "2026-10-01T00:00:00.000Z",
})
const request = (requestId: string, startedAt = "2026-10-01T00:01:00.000Z"): Record<string, unknown> => ({
	version: 1,
	type: "request",
	workId: WORK,
	sessionId: SESSION,
	requestId,
	startedAt,
	recordedAt: "2026-10-01T00:30:00.000Z",
})

describe("cursor decisions (pure)", () => {
	const file = Buffer.from(line(work()) + line(request("req-1")))

	it("a missing cursor starts a fresh import at generation 1, offset 0", () => {
		expect(journalDecision(undefined, 1, 2, file.length, file)).toEqual({ mode: "fresh", generation: 1, offset: 0 })
	})

	it("an unchanged file fully consumed is a clean no-op", () => {
		const cursor: JournalCursor = {
			path: "/j",
			dev: 1,
			ino: 2,
			generation: 1,
			offset: file.length,
			boundaryHash: boundaryHashOf(file, file.length),
			updatedAt: 1,
		}
		expect(journalDecision(cursor, 1, 2, file.length, file)).toEqual({
			mode: "clean-append",
			generation: 1,
			offset: file.length,
		})
	})

	it("new bytes on the same inode with an unchanged consumed prefix continue the append", () => {
		// The consumed prefix is unchanged; a NEW trailing line makes the file larger.
		const appended = Buffer.from(line(work()) + line(request("req-1")) + line(request("req-2")))
		const cursor: JournalCursor = {
			path: "/j",
			dev: 1,
			ino: 2,
			generation: 1,
			offset: file.length,
			boundaryHash: boundaryHashOf(file, file.length),
			updatedAt: 1,
		}
		expect(journalDecision(cursor, 1, 2, appended.length, appended)).toEqual({
			mode: "clean-append",
			generation: 1,
			offset: file.length,
		})
	})

	it("a shrink or a changed prefix is a mutation with generation++ and offset 0", () => {
		const cursor: JournalCursor = {
			path: "/j",
			dev: 1,
			ino: 2,
			generation: 1,
			offset: file.length,
			boundaryHash: boundaryHashOf(file, file.length),
			updatedAt: 1,
		}
		const shrunk = file.subarray(0, file.length - 10)
		expect(journalDecision(cursor, 1, 2, shrunk.length, shrunk)).toEqual({ mode: "mutation", generation: 2, offset: 0 })
		// Same size, different content: boundary hash no longer matches.
		const rewritten = Buffer.from(line(request("req-9")) + line(request("req-8")))
		expect(journalDecision(cursor, 1, 2, rewritten.length, rewritten)).toEqual({
			mode: "mutation",
			generation: 2,
			offset: 0,
		})
	})

	it("an inode change is a mutation regardless of bytes", () => {
		const cursor: JournalCursor = {
			path: "/j",
			dev: 1,
			ino: 2,
			generation: 1,
			offset: file.length,
			boundaryHash: boundaryHashOf(file, file.length),
			updatedAt: 1,
		}
		expect(journalDecision(cursor, 1, 99, file.length, file)).toEqual({ mode: "mutation", generation: 2, offset: 0 })
	})
})

describe("line splitting (pure)", () => {
	it("splits complete LF-terminated lines and excludes an unterminated tail", () => {
		const file = Buffer.from("aa\nbb\ncc")
		expect(completeLines(file, 0, file.length)).toEqual([
			{ start: 0, end: 3, text: "aa" },
			{ start: 3, end: 6, text: "bb" },
		])
	})

	it("respects a bounded window and resumes at the cursor", () => {
		const file = Buffer.from("aa\nbb\ncc\ndd\n")
		expect(completeLines(file, 3, 6)).toEqual([{ start: 3, end: 6, text: "bb" }])
		expect(completeLines(file, 3, file.length)).toHaveLength(3)
	})

	it("boundaryHashOf hashes the consumed prefix", () => {
		const empty = Buffer.alloc(0)
		expect(boundaryHashOf(empty, 0)).toBe(createHash("sha256").digest("hex"))
		expect(boundaryHashOf(empty, 0)).toBe(boundaryHashOf(empty, 0))
		const file = Buffer.from("abc")
		expect(boundaryHashOf(file, 3)).toBe(createHash("sha256").update(file).digest("hex"))
		expect(boundaryHashOf(file, 3)).not.toBe(boundaryHashOf(file, 2))
	})
})

describe("import loop over the memory backend", () => {
	const dirs: string[] = []
	afterEach(() => {
		useBackendFactory(null)
		closeBackends()
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("imports validated records, reports damaged lines, and ignores unknown types", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		writeFileSync(
			join(folder, "parent.jsonl"),
			line(work()) +
				"not json{{{\n" +
				line(request("req-1")) +
				'{"version":1,"type":"future_kind","workId":"' +
				WORK +
				'","sessionId":"' +
				SESSION +
				'"}\n',
		)
		const result = await importJournals(dir)
		expect(result.imported).toBe(2)
		expect(result.skipped).toBe(0)
		expect(result.problems).toHaveLength(2)
		expect(result.problems[0]).toMatchObject({ kind: "invalid", path: join(folder, "parent.jsonl"), line: 2 })
		expect(result.problems[1]).toMatchObject({ kind: "unknown-type", path: join(folder, "parent.jsonl"), line: 4 })
		const records = readRecords(dir)
		expect(records).toHaveLength(2)
		expect(records.map((record) => record.type).sort()).toEqual(["request", "work"])
	})

	it("re-imports over unchanged journals insert nothing and skip the known rows", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + line(request("req-1")))
		const first = await importJournals(dir)
		expect(first).toMatchObject({ imported: 2, skipped: 0, files: [{ mode: "fresh", generation: 1 }] })
		const second = await importJournals(dir)
		expect(second.imported).toBe(0)
		expect(second.skipped).toBe(0)
		expect(readRecords(dir)).toHaveLength(2)
	})

	it("picks up appends after migration in a clean-append pass", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + line(request("req-1")))
		await importJournals(dir)
		appendFileSync(file, line(request("req-2", "2026-10-01T00:02:00.000Z")))
		const result = await importJournals(dir)
		expect(result).toMatchObject({ imported: 1, skipped: 0, files: [{ mode: "clean-append", generation: 1 }] })
		expect(readRecords(dir)).toHaveLength(3)
	})

	it("a replaced journal mutates: generation++, offset 0, no row is ever deleted", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + line(request("req-1")))
		await importJournals(dir)
		// Same work, new request rows; req-1 is gone from the file but must stay in the store.
		writeFileSync(file, line(work()) + line(request("req-2", "2026-10-01T00:02:00.000Z")))
		const result = await importJournals(dir)
		expect(result.anomalies).toEqual([{ path: file, code: "journal-mutation" }])
		expect(result).toMatchObject({ imported: 1, skipped: 1, files: [{ mode: "mutation", generation: 2 }] })
		const records = readRecords(dir)
		expect(records).toHaveLength(3)
		expect(records.map((record) => (record as { requestId?: string }).requestId).sort()).toEqual([
			"req-1",
			"req-2",
			undefined,
		])
	})

	it("a same-size rewrite is a mutation and both generations' lines survive", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		const first = line(request("req-1"))
		const second = line(request("req-2"))
		expect(Buffer.byteLength(first)).toBe(Buffer.byteLength(second))
		writeFileSync(file, first)
		await importJournals(dir)
		writeFileSync(file, second)
		const result = await importJournals(dir)
		expect(result.anomalies).toHaveLength(1)
		expect(result).toMatchObject({ imported: 1, skipped: 0, files: [{ mode: "mutation", generation: 2 }] })
		expect(readRecords(dir)).toHaveLength(2)
	})

	it("a shrink mutates and re-imports the surviving prefix without deleting rows", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + line(request("req-1")) + line(request("req-2")))
		await importJournals(dir)
		writeFileSync(file, line(work()) + line(request("req-1")))
		const result = await importJournals(dir)
		expect(result.anomalies).toHaveLength(1)
		expect(result).toMatchObject({ imported: 0, skipped: 2, files: [{ mode: "mutation", generation: 2 }] })
		expect(readRecords(dir)).toHaveLength(3)
	})

	it("a removed journal keeps the imported rows and reports journal-removed", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + line(request("req-1")))
		await importJournals(dir)
		unlinkSync(file)
		const result = await importJournals(dir)
		expect(result.anomalies).toEqual([{ path: file, code: "journal-removed" }])
		expect(result.imported).toBe(0)
		expect(readRecords(dir)).toHaveLength(2)
		// Still replaying identically after the file is gone.
		expect(
			readRecords(dir)
				.map((record) => (record as { requestId?: string }).requestId)
				.includes("req-1"),
		).toBe(true)
	})

	it("an unterminated partial tail is deferred and retried once complete", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		const head = line(work())
		writeFileSync(file, head + line(request("req-1")).slice(0, -1)) // drop the trailing LF only
		const first = await importJournals(dir)
		expect(first.imported).toBe(1)
		expect(readRecords(dir)).toHaveLength(1)
		appendFileSync(file, "\n") // the tail becomes complete
		const second = await importJournals(dir)
		expect(second.imported).toBe(1)
		expect(readRecords(dir)).toHaveLength(2)
	})

	it("journal rows with explicit scope:null replay as null", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		writeFileSync(join(folder, "parent.jsonl"), line({ ...request("req-1"), scope: null }))
		await importJournals(dir)
		const records = readRecords(dir)
		expect(records).toHaveLength(1)
		expect((records[0] as { scope?: unknown }).scope).toBe(null)
	})

	it("claims a fully-consumed unchanged file without re-scanning it every pass", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()))
		await importJournals(dir)
		const after = await importJournals(dir)
		expect(after.imported).toBe(0)
		expect(after.files).toEqual([]) // no re-scan entry, no mutation anomaly
		expect(after.anomalies).toEqual([])
	})

	it("a duplicate line re-imported after a file mutation never folds over newer captured state", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		const response = (responseId: string) => ({
			version: 1 as const,
			type: "request_response" as const,
			workId: WORK,
			sessionId: SESSION,
			requestId: "req-1",
			responseId,
			startedAt: "2026-10-01T00:01:00.000Z",
			recordedAt: "2026-10-01T00:31:00.000Z",
		})
		writeFileSync(file, line(work()) + line(response("resp-503")) + line(request("req-9")))
		await importJournals(dir)
		expect(readRecords(dir)).toHaveLength(3)

		// A newer capture replaces the projection row for the same request.
		capture(dir, response("resp-200"), "/captured")
		expect(readRecords(dir)).toHaveLength(4)
		const requests = readWorkRows(dir, WORK, "requests") ?? []
		expect(requests.find((row) => (row as { requestId?: unknown }).requestId === "req-1")).toMatchObject({
			responseId: "resp-200",
		})

		// The journal is replaced with its original (smaller) bytes: a mutation pass re-reads the whole
		// file, the 503 line is a duplicate, and the import must NOT fold it back over the newer capture.
		writeFileSync(file, line(work()) + line(response("resp-503")))
		const after = await importJournals(dir)
		expect(after.imported).toBe(0)
		expect(after.skipped).toBe(2)
		expect(after.anomalies).toEqual([{ path: file, code: "journal-mutation" }])
		expect(readRecords(dir)).toHaveLength(4) // nothing withdrawn
		// Re-read AFTER the pass: a duplicate fold-back would regress the projection to resp-503.
		const refresh = readWorkRows(dir, WORK, "requests") ?? []
		expect(refresh.find((row) => (row as { requestId?: unknown }).requestId === "req-1")).toMatchObject({
			responseId: "resp-200",
		})
	})

	it("a record larger than the batch window imports across passes instead of stalling", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const big = { ...request("req-1"), padding: "x".repeat(500) }
		writeFileSync(join(folder, "parent.jsonl"), line(big) + line(request("req-2")))
		const first = await importJournals(dir, { maxBytes: 128 })
		expect(first.imported).toBe(1) // the straddling first complete record is allowed past the boundary
		expect(first.problems).toEqual([])
		const second = await importJournals(dir, { maxBytes: 128 })
		expect(second.imported).toBe(1)
		const third = await importJournals(dir, { maxBytes: 128 })
		expect(third.imported).toBe(0)
		expect(readRecords(dir).map((record) => record.requestId)).toEqual(["req-1", "req-2"])
	})

	it("an LF-terminated malformed final line is reported, not suppressed as an unfinished tail", async () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		writeFileSync(file, line(work()) + "not json{{{\n")
		const first = await importJournals(dir)
		expect(first.imported).toBe(1)
		expect(first.problems).toEqual([{ kind: "invalid", path: file, line: 2 }])
		// The cursor advanced past the corrupt line; a second pass is silent, not repeatedly loud.
		const second = await importJournals(dir)
		expect(second.imported).toBe(0)
		expect(second.problems).toEqual([])
	})
})

describe("A2 hydration before history-dependent reads", () => {
	const dirs: string[] = []
	afterEach(() => {
		useBackendFactory(null)
		closeBackends()
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	it("folds legacy journals in before the first history-dependent read, files stay untouched", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		const file = join(folder, "parent.jsonl")
		const original = line(work()) + line(request("req-1"))
		writeFileSync(file, original)
		hydrateLegacyOnce(dir)
		const records = readRecords(dir)
		expect(records.map((record) => record.type).sort()).toEqual(["request", "work"])
		// Legacy files are read-only inputs: hydration never deletes, converts, or rewrites them.
		expect(readFileSync(file, "utf8")).toBe(original)
	})

	it("re-hydration over an identical journal imports nothing new and advances no cursor", () => {
		const dir = agentDir()
		dirs.push(dir)
		useBackendFactory(() => createMemoryRecords())
		const folder = journal(dir)
		writeFileSync(join(folder, "parent.jsonl"), line(work()) + line(request("req-1")))
		hydrateLegacy(dir)
		expect(readRecords(dir)).toHaveLength(2)
		hydrateLegacy(dir)
		expect(readRecords(dir)).toHaveLength(2)
	})
})

describe("legacy journals import into SQLite via the Bun driver", { skip: isBun, timeout: 90_000 }, () => {
	async function driver(...args: string[]): Promise<unknown> {
		const stdout = execFileSync("bun", [DRIVER, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 })
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
	}

	it("read-work-records hydrates legacy journals before a history-dependent read", async () => {
		const dir = agentDir()
		try {
			mkdirSync(join(dir, "work-attribution"), { recursive: true })
			writeFileSync(join(dir, "work-attribution", "parent.jsonl"), line(work()) + line(request("req-1")))
			const records = (await driver("read-work-records", dir)) as { type: string }[]
			expect(records.map((record) => record.type).sort()).toEqual(["request", "work"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("fresh + append + re-import over unchanged files insert nothing new", async () => {
		const dir = agentDir()
		try {
			const folder = journal(dir)
			const file = join(folder, "parent.jsonl")
			writeFileSync(file, line(work()) + line(request("req-1")))
			const first = (await driver("import-journals", dir)) as {
				imported: number
				skipped: number
				files: { mode: string; generation: number; imported: number; skipped: number }[]
			}
			expect(first.imported).toBe(2)
			expect(first.files[0]).toMatchObject({ mode: "fresh", generation: 1, imported: 2, skipped: 0 })

			const noop = (await driver("import-journals", dir)) as { imported: number }
			expect(noop.imported).toBe(0)

			appendFileSync(file, line(request("req-2", "2026-10-01T00:02:00.000Z")))
			const appended = (await driver("import-journals", dir)) as {
				imported: number
				files: { mode: string; generation: number; imported: number }[]
			}
			expect(appended.imported).toBe(1)
			expect(appended.files[0]).toMatchObject({ mode: "clean-append", generation: 1, imported: 1 })

			const rows = (await driver("records", dir, WORK)) as { requestId?: string }[]
			expect(rows).toHaveLength(3)
			expect(
				rows
					.map((row) => row.requestId)
					.filter(Boolean)
					.sort(),
			).toEqual(["req-1", "req-2"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("anomaly matrix: replace-larger, shrink, and remove never delete imported rows", async () => {
		const dir = agentDir()
		try {
			const folder = journal(dir)
			const file = join(folder, "parent.jsonl")
			writeFileSync(file, line(work()) + line(request("req-1")))
			await driver("import-journals", dir)

			// Replace with a larger file whose CONSUMED PREFIX changed (req-9 takes req-1's slot, req-2 appended):
			// mutation gen 2, both generations' unique lines survive.
			writeFileSync(file, line(work()) + line(request("req-9", "2026-10-01T00:09:00.000Z")) + line(request("req-2")))
			const replaced = (await driver("import-journals", dir)) as {
				anomalies: { code: string }[]
				imported: number
				skipped: number
				files: { mode: string; generation: number }[]
			}
			expect(replaced.anomalies.map((row) => row.code)).toEqual(["journal-mutation"])
			expect(replaced).toMatchObject({ imported: 2, skipped: 1, files: [{ mode: "mutation", generation: 2 }] })

			// Shrink back to the first line only.
			writeFileSync(file, line(work()))
			const shrunk = (await driver("import-journals", dir)) as { imported: number }
			expect(shrunk.imported).toBe(0)

			unlinkSync(file)
			const removed = (await driver("import-journals", dir)) as {
				anomalies: { code: string; path?: string }[]
				imported: number
			}
			expect(removed.anomalies).toEqual([{ code: "journal-removed", path: file }])
			expect(removed.imported).toBe(0)

			// Nothing was ever withdrawn: the gen-1 req-1 line and the gen-2 req-9/req-2 lines all survive.
			const rows = (await driver("records", dir, WORK)) as { requestId?: string }[]
			expect(
				rows
					.map((row) => row.requestId)
					.filter(Boolean)
					.sort(),
			).toEqual(["req-1", "req-2", "req-9"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("malformed lines and unknown types surface as coverage problems; valid rows still import", async () => {
		const dir = agentDir()
		try {
			const folder = journal(dir)
			writeFileSync(
				join(folder, "parent.jsonl"),
				line(work()) +
					"not json{{{\n" +
					line(request("req-2")) +
					'{"version":1,"type":"future_kind","workId":"' +
					WORK +
					'","sessionId":"' +
					SESSION +
					'"}\n',
			)
			const result = (await driver("import-journals", dir)) as {
				problems: { kind: string }[]
				imported: number
				files: { imported: number }[]
			}
			expect(result.problems.map((problem) => problem.kind).sort()).toEqual(["invalid", "unknown-type"])
			expect(result).toMatchObject({ imported: 2, files: [{ imported: 2 }] })
			const rows = (await driver("records", dir, WORK)) as { type: string }[]
			expect(rows).toHaveLength(2)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("scope:null in a journal line replays as null through the real backend", async () => {
		const dir = agentDir()
		try {
			const folder = journal(dir)
			writeFileSync(join(folder, "parent.jsonl"), line({ ...request("req-1"), scope: null }))
			await driver("import-journals", dir)
			const rows = (await driver("records", dir, WORK)) as { scope?: unknown }[]
			expect(rows).toHaveLength(1)
			expect(rows[0].scope).toBe(null)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("imports journals from the transitions subdirectory too", async () => {
		const dir = agentDir()
		try {
			mkdirSync(join(dir, "work-attribution", "transitions"), { recursive: true })
			writeFileSync(join(dir, "work-attribution", "transitions", "t.jsonl"), line(work()))
			const result = (await driver("import-journals", dir)) as { imported: number; files: { path: string }[] }
			expect(result.imported).toBe(1)
			expect(result.files[0].path).toContain(join("work-attribution", "transitions"))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("refuses nothing when only the agent dir exists; empty import is a clean no-op", async () => {
		const dir = agentDir()
		try {
			journal(dir)
			const result = (await driver("import-journals", dir)) as {
				imported: number
				anomalies: unknown[]
				files: unknown[]
			}
			expect(result).toMatchObject({ imported: 0, anomalies: [], files: [] })
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
