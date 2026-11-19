import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type * as asyncFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type {
	BeforeProviderHeadersEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { savedWorkSummary, saveWorkSummary } from "../__mocks__/work-summary.js"
import { backendFor, capture, type StoredRecord } from "../pr-cost-reporting/ledger/records.js"
import {
	appendWorkRecord,
	createWorkAttributionExtension,
	getWorkId,
	recordProviderRequest,
	setWorkId,
	tryWorkAttribution,
} from "../work-attribution.js"

import * as diagnostics from "./diagnostics.js"
import type { Row, WorkHead } from "./row-log.js"
import {
	flushWorkSummaries,
	journalParser,
	readWorkRecords,
	readWorkRecordsAsync,
	recoverWorkSummaries,
	type WorkRecord,
	type WorkRecordProblem,
} from "./summary.js"

vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof asyncFs>()) }))
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

let dir: string
beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "kimchi-work-summary-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
})
afterEach(async () => {
	await flushWorkSummaries()
	try {
		expect(vi.getTimerCount()).toBe(0)
	} finally {
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		fs.rmSync(dir, { recursive: true, force: true })
	}
})
function context(sessionId = "parent") {
	return createContext({ cwd: "/project", sessionManager: { getSessionId: () => sessionId } })
}
function path(workId: string) {
	return join(dir, "work", workId, "work.json")
}
function summary(workId: string) {
	return savedWorkSummary(dir, workId)
}
function recoverProjection(workId: string): void {
	const backend = backendFor(dir)
	const authority = backend.readRecords({ workId })
	backend.tx(() => {
		backend.clearProjection(workId)
		backend.markDirty(workId)
	})
	expect(backend.getHead(workId)).toBeUndefined()
	recoverWorkSummaries()
	expect(backend.getHead(workId)).toBeDefined()
	expect(backend.dirtyWorks()).not.toContain(workId)
	expect(backend.readRecords({ workId })).toEqual(authority)
}

function parseLegacyJournal(
	ledger: string,
	text: string,
	onProblem?: (problem: WorkRecordProblem) => void,
): WorkRecord[] {
	const records: WorkRecord[] = []
	const parse = journalParser(ledger, records, onProblem)
	const lines = text.split("\n")
	for (const [index, line] of lines.entries()) parse(line, index === lines.length - 1)
	return records
}

const NATIVE_DRIVER = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
interface NativeSummaryState {
	authority: { record_hash: string; body: string }[]
	markers: { record_hash: string }[]
	head: string | null
	rows: { log: string; key: string; pos: number; body: string }[]
}
function native<T>(command: string, argument: unknown): T {
	const output = execFileSync(
		"bun",
		[NATIVE_DRIVER, command, dir, typeof argument === "string" ? argument : JSON.stringify(argument)],
		{ encoding: "utf8", timeout: 10000 },
	)
	return JSON.parse(output.trim().split("\n").at(-1) ?? "null")
}
function coherentState(state: NativeSummaryState) {
	expect(state.markers.map((row) => row.record_hash).sort()).toEqual(
		state.authority.map((row) => row.record_hash).sort(),
	)
	for (const row of state.authority) expect(row.record_hash).toBe(createHash("sha256").update(row.body).digest("hex"))
	if (state.head === null) {
		expect(state.authority).toEqual([])
		expect(state.rows).toEqual([])
		return { requests: [] as Row[], sessions: [] as Row[] }
	}
	const head: WorkHead = JSON.parse(state.head)
	for (const [log, metadata] of Object.entries(head.logs)) {
		const rows = state.rows.filter((row) => row.log === log)
		expect(metadata).toMatchObject({
			rows: rows.length,
			bytes: rows.reduce((sum, row) => sum + Buffer.byteLength(row.body) + 1, 0),
		})
		expect(rows.map((row) => row.pos)).toEqual(rows.map((_, index) => index + 1))
	}
	const requests: Row[] = state.rows.filter((row) => row.log === "requests").map((row) => JSON.parse(row.body))
	const sessions: Row[] = state.rows.filter((row) => row.log === "sessions").map((row) => JSON.parse(row.body))
	const requestIds = state.authority
		.map((row): WorkRecord => JSON.parse(row.body))
		.filter((row) => row.type === "request")
		.map((row) => row.requestId)
	expect(requests.map((row) => row.requestId).sort()).toEqual([...new Set(requestIds)].sort())
	return { requests, sessions }
}
function nativeRecord(workId: string, sessionId = "native", requestId: string = randomUUID()): WorkRecord {
	return {
		version: 1,
		type: "request",
		workId,
		sessionId,
		requestId,
		scope: null,
		recordedAt: "2026-10-01T00:00:00.000Z",
	}
}
function startNativeProcess(command: "summary-writer" | "summary-reader", argument: string) {
	const child = spawn("bun", [NATIVE_DRIVER, command, dir, argument])
	const label = command === "summary-writer" ? "Native writer" : "Native reader"
	const lines = createInterface({ input: child.stdout })
	const messages = lines[Symbol.asyncIterator]()
	let errors = ""
	child.stderr.on("data", (chunk) => {
		errors += String(chunk)
	})
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${errors}`))))
	})
	const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
	void done.finally(() => clearTimeout(timeout)).catch(() => {})
	return {
		child,
		done,
		async next() {
			const line = await messages.next()
			if (line.done) throw new Error(`${label} ended before its barrier: ${errors}`)
			const message: { phase: string; state?: NativeSummaryState } = JSON.parse(line.value)
			return message
		},
		async stop() {
			if (child.exitCode === null) child.kill("SIGKILL")
			await done.catch(() => {})
			lines.close()
		},
	}
}
function startNative(record: WorkRecord, count = 1, beforeFlush = false) {
	const writer = startNativeProcess("summary-writer", JSON.stringify({ record, count, beforeFlush }))
	return { ...writer, next: async () => (await writer.next()).phase }
}

describe("readable work summaries", () => {
	it("keeps one PR after provider IDs are added and the repository is renamed", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const commit = { type: "commit", sha: "a".repeat(40), repository: "/project/.git", worktree: "/project" }
		const old = {
			provider: "github",
			host: "github.com",
			url: "https://github.com/example/old/pull/7",
			checkedAt: "2026-10-02T08:00:00Z",
		}
		appendWorkRecord(ctx, { ...commit, pullRequests: [old] })
		appendWorkRecord(ctx, { ...commit, pullRequests: [{ ...old, id: "42" }] })
		const renamed = {
			...old,
			id: "42",
			url: "https://github.com/example/new/pull/7",
			checkedAt: "2026-10-02T09:00:00Z",
		}
		appendWorkRecord(ctx, { ...commit, pullRequests: [renamed] })
		await flushWorkSummaries()
		expect(summary(workId).commits[0].pullRequests).toEqual([renamed])
		recoverProjection(workId)
		await flushWorkSummaries()
		expect(summary(workId).commits[0].pullRequests).toEqual([renamed])
	})
	it("reports malformed nonblank ledger rows without treating a trailing newline as lost history", () => {
		const ctx = context()
		recordProviderRequest(ctx)
		const invalid = vi.fn()
		const ledger = join(dir, "work-attribution", "parent.jsonl")
		readWorkRecords(dir, undefined, () => {}, invalid)
		expect(invalid).not.toHaveBeenCalled()
		fs.mkdirSync(dirname(ledger), { recursive: true })
		fs.appendFileSync(ledger, '\n{broken\n{"type":"request"}\n')
		readWorkRecords(dir, undefined, () => {}, invalid)
		expect(invalid).toHaveBeenCalledTimes(2)
	})
	it.each(["", "transitions"])("skips only interrupted appends in %s journals", async (source) => {
		const row = { version: 1, type: "work", workId: randomUUID(), sessionId: "writer" }
		const complete = JSON.stringify(row)
		// Keep the legacy parser matrix; the importer consumes only LF-terminated lines and dedups authority.
		const cases = [
			['{"type":"request"', 0, [row], 0, 1],
			['{"type":"request"\n', 1, [row], 1, 1],
			// Released writers start a new line after a cut-off record and append the next one.
			['{"type":"request"}', 1, [row], 0, 1],
			[`{"type":"request"\n${complete}`, 0, [row, row], 1, 0],
			[`{"type":"request","workId":"12\n${complete}`, 0, [row, row], 1, 0],
			[`{"type":"request"}x\n${complete}`, 1, [row, row], 1, 1],
			[complete, 0, [row, row], 0, 0],
		] as const
		for (const [index, [suffix, invalidCount, rows, beforeLf, afterLf]] of cases.entries()) {
			const agentDir = join(dir, `${source || "sessions"}-${index}`)
			const directory = join(agentDir, "work-attribution", source)
			fs.mkdirSync(directory, { recursive: true })
			const ledger = join(directory, "interrupted.jsonl")
			const text = `${complete}\n${suffix}`
			fs.writeFileSync(ledger, text)
			const legacyProblems = vi.fn()
			expect(parseLegacyJournal(ledger, text, legacyProblems)).toEqual(rows)
			expect(legacyProblems).toHaveBeenCalledTimes(invalidCount)
			const invalid = vi.fn()
			expect(readWorkRecords(agentDir, undefined, () => {}, invalid)).toEqual([row])
			expect(invalid).toHaveBeenCalledTimes(beforeLf)
			// The background reader sees the same durable coverage, without importing duplicate rows.
			const background = vi.fn()
			expect(await readWorkRecordsAsync(agentDir, new AbortController().signal, background)).toEqual([row])
			expect(background.mock.calls).toEqual(invalid.mock.calls)
			if (!text.endsWith("\n")) fs.appendFileSync(ledger, "\n")
			const completed = vi.fn()
			expect(readWorkRecords(agentDir, undefined, () => {}, completed)).toEqual([row])
			expect(completed).toHaveBeenCalledTimes(afterLf)
		}
	})
	it("reports damage and complete records of unknown types as separate problems", async () => {
		const row = { version: 1, type: "work", workId: randomUUID(), sessionId: "writer" }
		// A newer Kimchi sharing this history can add record types that this version cannot interpret.
		const newer = { ...row, type: "work_checkpoint", sessionId: "newer", requestIds: [randomUUID()] }
		const ledger = join(dir, "work-attribution", "mixed.jsonl")
		fs.mkdirSync(dirname(ledger), { recursive: true })
		const lines = [row, newer, { ...newer, workId: "not-a-work-id" }, { ...row, type: "request" }].map((value) =>
			JSON.stringify(value),
		)
		const text = `${lines.join("\n")}\n{broken\n${JSON.stringify(row)}\n`
		fs.writeFileSync(ledger, text)
		const legacyProblems = vi.fn()
		expect(parseLegacyJournal(ledger, text, legacyProblems)).toEqual([row, row])
		const problems = vi.fn()
		expect(readWorkRecords(dir, undefined, () => {}, problems)).toEqual([row])
		// Both kinds reach the callback, so readers that need complete history still see an unknown type.
		expect(problems.mock.calls).toEqual([
			[{ kind: "unknown-type", path: ledger, line: 2, record: newer }],
			[{ kind: "invalid", path: ledger, line: 3 }],
			[{ kind: "invalid", path: ledger, line: 4 }],
			[{ kind: "invalid", path: ledger, line: 5 }],
		])
		expect(legacyProblems.mock.calls).toEqual(problems.mock.calls)
		const background = vi.fn()
		expect(await readWorkRecordsAsync(dir, new AbortController().signal, background)).toEqual([row])
		expect(background.mock.calls).toEqual(problems.mock.calls)
	})
	it("skips a record cut at any position, including inside a \\u escape", () => {
		const row = { version: 1, type: "work", workId: randomUUID(), sessionId: "writer" }
		const complete = JSON.stringify(row)
		// Provider and Git errors keep terminal colours, which JSON writes as \u001b escapes.
		const cut = JSON.stringify({
			...row,
			type: "commit",
			sha: "a".repeat(40),
			prLookup: { status: "error", error: '\u001b[31mGitHub said "no"\u001b[0m\tC:\\repo\n', attempts: [1, -1.5e3] },
			complete: false,
		})
		const escapes = [...cut.matchAll(/\\u001b/g)].map((match) => match.index)
		expect(escapes).toHaveLength(2)
		for (let end = 1; end < cut.length; end++) {
			const agentDir = join(dir, `cut-${end}`)
			const ledger = join(agentDir, "work-attribution", "interrupted.jsonl")
			fs.mkdirSync(dirname(ledger), { recursive: true })
			const text = `${complete}\n${cut.slice(0, end)}\n${complete}\n`
			fs.writeFileSync(ledger, text)
			const legacyProblems = vi.fn()
			expect(parseLegacyJournal(ledger, text, legacyProblems)).toEqual([row, row])
			expect({ end, invalid: legacyProblems.mock.calls.length }).toEqual({ end, invalid: 0 })
			const invalid = vi.fn()
			expect(readWorkRecords(agentDir, undefined, () => {}, invalid)).toEqual([row])
			expect({ end, invalid: invalid.mock.calls.length }).toEqual({ end, invalid: 0 })
		}
	})

	it("retains PR links and their newest state through failed lookups and source replay", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const commit = { type: "commit", sha: "a".repeat(40), repository: "/project/.git", worktree: "/project" }
		const open = {
			url: "https://github.com/example/repo/pull/7",
			number: 7,
			state: "open",
			checkedAt: "2026-10-02T08:00:00Z",
		}
		const merged = { ...open, state: "merged", mergeCommitSha: "b".repeat(40), checkedAt: "2026-10-02T09:00:00Z" }
		appendWorkRecord(ctx, {
			...commit,
			pullRequests: [open],
			prLookup: { status: "linked", checkedAt: open.checkedAt },
		})
		appendWorkRecord(ctx, {
			...commit,
			pullRequests: [merged],
			prLookup: { status: "linked", checkedAt: merged.checkedAt },
		})
		const failure = { status: "error", checkedAt: "2026-10-02T10:00:00Z", error: "Run gh auth login" }
		appendWorkRecord(ctx, { ...commit, pullRequests: [], prLookup: failure })
		// A replay or later file reconciliation must not reset network observations.
		appendWorkRecord(ctx, {
			...commit,
			pullRequests: [open],
			prLookup: { status: "linked", checkedAt: open.checkedAt },
		})
		appendWorkRecord(ctx, { ...commit, paths: ["example.ts"] })
		await flushWorkSummaries()
		expect(summary(workId).commits).toHaveLength(1)
		expect(summary(workId).commits[0]).toMatchObject({
			pullRequests: [merged],
			prLookup: failure,
			paths: ["example.ts"],
		})
		recoverProjection(workId)
		await flushWorkSummaries()
		expect(summary(workId).commits[0]).toMatchObject({ pullRequests: [merged], prLookup: failure })
	})
	it.each(["priced", "unavailable"])("keeps newer billing status (%s) through delayed recovery", async (status) => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const request = recordProviderRequest(ctx)
		const charge = { id: randomUUID(), costUsd: "0.25" }
		const priced = { status: "priced" }
		const unavailable = { status: "unavailable", reason: "Billing API returned HTTP 503" }
		const older = { ...(status === "priced" ? unavailable : priced), checkedAt: "2026-10-04T09:00:00Z" }
		const newer = { ...(status === "priced" ? priced : unavailable), checkedAt: "2026-10-04T09:05:00Z" }
		appendWorkRecord(ctx, {
			type: "request_cost",
			requestId: request.requestId,
			billingRows: older.status === "priced" ? [charge] : [],
			billingLookup: older,
		})
		await flushWorkSummaries()
		const captured = readWorkRecords(dir).find(
			(row) => row.type === "request_cost" && row.requestId === request.requestId,
		)
		if (!captured) throw new Error("Expected the older billing observation")
		// A legacy writer can publish an older observation after a newer one has already committed.
		// Give it distinct record bytes so this exercises timestamp precedence, not only hash dedup.
		const delayed = { ...captured, recordedAt: "2026-10-04T09:01:00Z" }
		appendWorkRecord(ctx, {
			type: "request_cost",
			requestId: request.requestId,
			billingRows: newer.status === "priced" ? [charge] : [],
			billingLookup: newer,
		})
		await flushWorkSummaries()
		expect(summary(workId).requests[0].billingLookup).toEqual(newer)
		const authority = backendFor(dir).readRecords({ workId })
		const ledger = join(dir, "work-attribution", "delayed-billing.jsonl")
		fs.mkdirSync(dirname(ledger), { recursive: true })
		fs.writeFileSync(ledger, `${JSON.stringify(delayed)}\n`)
		const problems = vi.fn()
		readWorkRecords(dir, undefined, () => {}, problems)
		expect(problems).not.toHaveBeenCalled()
		expect(backendFor(dir).readRecords({ workId })).toHaveLength(authority.length + 1)
		expect(backendFor(dir).readRecords({ workId }).slice(0, authority.length)).toEqual(authority)
		expect(summary(workId).requests[0]).toMatchObject({ billingLookup: newer, billingRows: [charge] })
		recoverProjection(workId)
		await flushWorkSummaries()
		expect(summary(workId).requests[0]).toMatchObject({ billingLookup: newer, billingRows: [charge] })
	})
	it("reads large journals in the background without blocking the event loop", async () => {
		const ledgers = join(dir, "work-attribution")
		fs.mkdirSync(join(ledgers, "transitions"), { recursive: true })
		const workId = randomUUID()
		const row = (requestId: string, note = "") =>
			JSON.stringify({ version: 1, type: "request", workId, sessionId: "large", requestId, note })
		// About 6 MiB in several files; one multi-byte note crosses a read chunk boundary.
		const lines = Array.from({ length: 20_000 }, () => row(randomUUID(), "x".repeat(200)))
		const primary = `${row(randomUUID(), "é".repeat(700_000))}\n${lines.join("\n")}\n`
		const transitions = `${lines.slice(0, 1000).join("\n")}\ninterrupted`
		const primaryPath = join(ledgers, "large.jsonl")
		const transitionsPath = join(ledgers, "transitions", "edits.jsonl")
		fs.writeFileSync(primaryPath, primary)
		fs.writeFileSync(transitionsPath, transitions)
		// The legacy parser sees all 21,001 observations; the authority dedups the repeated 1,000 exact lines.
		expect([
			...parseLegacyJournal(primaryPath, primary),
			...parseLegacyJournal(transitionsPath, transitions),
		]).toHaveLength(21_001)
		let turns = 0
		let reading = true
		const spin = () => {
			turns++
			if (reading) setImmediate(spin)
		}
		setImmediate(spin)
		const records = await readWorkRecordsAsync(dir, new AbortController().signal)
		reading = false
		expect(records).toHaveLength(20_001)
		expect(records).toEqual(readWorkRecords(dir))
		expect(fs.readFileSync(primaryPath, "utf8")).toBe(primary)
		expect(fs.readFileSync(transitionsPath, "utf8")).toBe(transitions)
		// The synchronous reader would let no other callback run until it finished.
		expect(turns).toBeGreaterThanOrEqual(6)
	})
	it("lists each billing ID once with its latest observation, including after a replay", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const { requestId } = recordProviderRequest(ctx)
		const id = randomUUID()
		const other = randomUUID()
		const pending = {
			type: "request_cost",
			requestId,
			billingRows: [{ id, costUsd: null, createTime: "2026-10-08T10:00:01Z" }],
			billingLookup: { status: "pending", checkedAt: "2026-10-08T10:00:30.000Z" },
		}
		const priced = {
			type: "request_cost",
			requestId,
			billingRows: [{ id, costUsd: "0.000166000", createTime: "2026-10-08T10:00:01Z", model: "glm-5.3" }],
			billingLookup: { status: "priced", checkedAt: "2026-10-08T10:05:30.000Z" },
		}
		appendWorkRecord(ctx, pending)
		appendWorkRecord(ctx, priced)
		// A delayed older observation neither duplicates nor replaces the later price.
		appendWorkRecord(ctx, {
			...pending,
			billingRows: [...pending.billingRows, { id: other, costUsd: null }],
		})
		await flushWorkSummaries()
		const expected = [priced.billingRows[0], { id: other, costUsd: null }]
		expect(summary(workId).requests[0]).toMatchObject({ billingRows: expected, billingLookup: priced.billingLookup })
		recoverProjection(workId)
		await flushWorkSummaries()
		expect(summary(workId).requests[0].billingRows).toEqual(expected)
	})
	it.each([
		"billingLookup",
		"prLookup",
		"pullRequests",
	])("recovers %s from a malformed observation timestamp", async (field) => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const base =
			field === "billingLookup"
				? { type: "request_cost", requestId: recordProviderRequest(ctx).requestId }
				: { type: "commit", sha: "a".repeat(40), repository: "/project/.git", worktree: "/project" }
		const invalid = {
			url: "https://github.com/example/repo/pull/7",
			status: "unavailable",
			checkedAt: "invalid-history",
		}
		const valid = { ...invalid, status: "complete", checkedAt: "2026-10-04T10:00:00Z" }
		for (const observation of [invalid, valid, invalid]) {
			appendWorkRecord(ctx, { ...base, [field]: field === "pullRequests" ? [observation] : observation })
			await flushWorkSummaries()
		}
		const row = field === "billingLookup" ? summary(workId).requests[0] : summary(workId).commits[0]
		expect(row[field]).toEqual(field === "pullRequests" ? [valid] : valid)
	})
	it("retains hunk matches and lets only stronger file evidence replace them", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const commit = { type: "commit", sha: "a".repeat(40), repository: "/project/.git", worktree: "/project" }
		const record = async (method: string, transitionId: string) => {
			appendWorkRecord(ctx, {
				...commit,
				fileMatches: [{ path: "file.ts", method, transitionIds: [transitionId], worktree: "/project" }],
			})
			await flushWorkSummaries()
		}
		await record("file-hunks", "hunk-one")
		await record("file-hunks", "hunk-two")
		expect(summary(workId).commits[0].fileMatches).toEqual([
			{ path: "file.ts", method: "file-hunks", transitionIds: ["hunk-one", "hunk-two"], worktree: "/project" },
		])
		await record("path-blob", "blob")
		await record("file-hunks", "late-hunk")
		expect(summary(workId).commits[0].fileMatches).toEqual([
			{ path: "file.ts", method: "path-blob", transitionIds: ["blob"], worktree: "/project" },
		])
		await record("file-chain", "exact")
		await record("path-blob", "late-blob")
		await record("file-hunks", "last-hunk")
		expect(summary(workId).commits[0].fileMatches).toEqual([
			{ path: "file.ts", method: "file-chain", transitionIds: ["exact"], worktree: "/project" },
		])
	})
	it("shows why a session continued another work without changing request timestamps", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const request = recordProviderRequest(ctx)
		await flushWorkSummaries()
		const original = summary(workId).requests[0]
		const continuation = {
			source: "recent-branch",
			evidence: { path: "/project/ADR.md", transitionId: "plan-edit", branch: "feature" },
		}
		appendWorkRecord(context("implementer"), { type: "work", continuation }, workId)
		appendWorkRecord(context("implementer"), { type: "work", continuation }, workId)
		await flushWorkSummaries()
		expect(summary(workId).requests[0]).toEqual(original)
		expect(summary(workId).requests[0].requestId).toBe(request.requestId)
		expect(summary(workId).continuations).toEqual([
			expect.objectContaining({
				sessionId: "implementer",
				cwd: "/project",
				recordedAt: expect.any(String),
				...continuation,
			}),
		])
	})
	it("keeps every retained version when the local plan path is reused", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		for (const snapshotPath of ["/work/plans/v1.md", "/work/plans/v2.md", "/work/plans/v2.md"])
			appendWorkRecord(ctx, { type: "plan", path: "/project/.kimchi/plans/feature.md", snapshotPath })
		await flushWorkSummaries()
		expect(summary(workId).plans.map((plan) => plan.snapshotPath)).toEqual(["/work/plans/v1.md", "/work/plans/v2.md"])
	})
	it("commits a pending native capture before shutdown flush completes", async () => {
		const workId = randomUUID()
		const record = nativeRecord(workId)
		const writer = startNative(record)
		try {
			expect(await writer.next()).toBe("ready")
			expect(await writer.next()).toBe("pending")
			// A separate WAL reader sees neither the uncommitted header nor its authority/marker.
			const pending = native<NativeSummaryState>("summary-state", workId)
			expect(pending).toEqual({ authority: [], markers: [], head: null, rows: [] })
			expect(writer.child.exitCode).toBeNull()
			writer.child.stdin.write("c")
			expect(await writer.next()).toBe("committed")
			expect(await writer.next()).toBe("flushed")
			await writer.done
			const reopened = native<NativeSummaryState>("summary-state", workId)
			expect(coherentState(reopened).requests).toEqual([
				expect.objectContaining({ requestId: record.requestId, scope: null }),
			])
			expect(fs.existsSync(path(workId))).toBe(false)
			expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false)
		} finally {
			await writer.stop()
		}
	}, 15000)
	it("automatically separates work while merging parent, child, request, plan and commit provenance", async () => {
		const parent = context()
		const child = context("child")
		const workId = getWorkId(parent)
		setWorkId(child, workId)
		const first = recordProviderRequest(parent, { provider: "test", id: "model" })
		const second = recordProviderRequest(child, { provider: "test", id: "model" })
		appendWorkRecord(child, { type: "plan", path: "/project/plan.md" })
		const commit = {
			type: "commit",
			sha: "sha",
			repository: "/project/.git",
			worktree: "/project",
			paths: ["a.ts"],
			transitionIds: ["first"],
		}
		appendWorkRecord(child, commit)
		appendWorkRecord(child, commit)
		appendWorkRecord(child, { ...commit, paths: ["b.ts"], transitionIds: ["second"] })
		const next = setWorkId(parent)
		recordProviderRequest(parent)
		await flushWorkSummaries()
		const value = summary(workId)
		expect(value).toMatchObject({ workId, sessions: expect.arrayContaining(["parent", "child"]) })
		expect(value.requests).toHaveLength(2)
		expect(value.requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: first.requestId, sessionId: "parent", model: "model" }),
				expect.objectContaining({ requestId: second.requestId, sessionId: "child" }),
			]),
		)
		expect(value.plans).toEqual([expect.objectContaining({ path: "/project/plan.md", sessionId: "child" })])
		expect(value.commits).toEqual([
			expect.objectContaining({
				sha: "sha",
				sessionId: "child",
				paths: ["a.ts", "b.ts"],
				transitionIds: ["first", "second"],
			}),
		])
		expect(value.requests[0]).not.toHaveProperty("workId")
		expect(value.requests[0]).not.toHaveProperty("version")
		expect(value.requests[0]).not.toHaveProperty("type")
		expect(summary(next).requests).toHaveLength(1)
	})
	it("retains request-to-file links and different originating sessions for the same commit", async () => {
		const workId = getWorkId(context())
		for (const session of ["parent", "child"])
			appendWorkRecord(
				context(session),
				{ type: "commit", sha: "sha", repository: "/repo", worktree: "/tree", paths: [session] },
				workId,
			)
		appendWorkRecord(
			context(),
			{
				type: "file_transition",
				transitionId: "transition",
				requestId: "request",
				toolCallId: "write",
				repository: "/other/.git",
				worktree: "/other",
				path: "file.ts",
				before: null,
				after: { blob: "blob", mode: "100644" },
			},
			workId,
			join(dir, "work-attribution", "transitions", "journal.jsonl"),
		)
		await flushWorkSummaries()
		expect(
			summary(workId)
				.commits.map((entry) => entry.sessionId)
				.sort(),
		).toEqual(["child", "parent"])
		expect(summary(workId).fileTransitions).toEqual([
			expect.objectContaining({
				transitionId: "transition",
				requestId: "request",
				toolCallId: "write",
				repository: "/other/.git",
				worktree: "/other",
				path: "file.ts",
			}),
		])
	})
	it("merges commit file evidence without replacing stronger matches or losing transitions", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const commit = { type: "commit", sha: "sha", repository: "/repo", worktree: "/target" }
		for (const [method, transitionId] of [
			["path-blob", "weak"],
			["file-chain", "exact"],
			["path-blob", "later"],
			["file-chain", "exact"],
			["file-chain", "exact-two"],
		])
			appendWorkRecord(ctx, {
				...commit,
				fileMatches: [{ path: "file.ts", method, transitionIds: [transitionId], worktree: "/origin" }],
			})
		appendWorkRecord(ctx, {
			...commit,
			fileMatches: [{ path: "other.ts", method: "file-chain", transitionIds: ["other"], worktree: "/origin" }],
		})
		await flushWorkSummaries()
		expect(summary(workId).commits[0].fileMatches).toEqual([
			{ path: "file.ts", method: "file-chain", transitionIds: ["exact", "exact-two"], worktree: "/origin" },
			{ path: "other.ts", method: "file-chain", transitionIds: ["other"], worktree: "/origin" },
		])
	})
	it("imports unchanged transition journals despite an old recovery stamp", async () => {
		const ctx = context()
		const request = recordProviderRequest(ctx)
		await flushWorkSummaries()
		const existing = structuredClone(summary(request.workId))
		const originalCount = backendFor(dir).recordCount(request.workId)
		const journal = join(dir, "work-attribution", "transitions", "old.jsonl")
		fs.mkdirSync(dirname(journal), { recursive: true })
		const journalBytes = `${JSON.stringify({ type: "file_transition", version: 1, workId: request.workId, sessionId: "parent", transitionId: "old-transition", toolCallId: "old-tool", repository: "/repo", worktree: "/tree", path: "file.ts", before: null, after: { blob: "blob", mode: "100644" } })}\n`
		fs.writeFileSync(journal, journalBytes)
		const past = new Date(Date.now() - 60 * 60 * 1000)
		fs.utimesSync(journal, past, past)
		const stamp = join(dir, "work-attribution", ".recovered.json")
		const stampBytes = JSON.stringify({ startedAt: Date.now(), summaries: { [request.workId]: "old" } })
		fs.writeFileSync(stamp, stampBytes)
		const journalMtime = fs.statSync(journal).mtimeMs
		vi.resetModules()
		const relaunched = await import("./summary.js")
		relaunched.recoverWorkSummaries()
		await relaunched.flushWorkSummaries()
		expect(summary(request.workId).requests[0]).toEqual(existing.requests[0])
		expect(summary(request.workId).fileTransitions).toEqual([
			expect.objectContaining({ transitionId: "old-transition", toolCallId: "old-tool" }),
		])
		expect(summary(request.workId).fileTransitions[0]).not.toHaveProperty("requestId")
		expect(backendFor(dir).recordCount(request.workId)).toBe(originalCount + 1)
		expect(fs.readFileSync(stamp, "utf8")).toBe(stampBytes)
		recoverProjection(request.workId)
		expect(summary(request.workId).fileTransitions).toHaveLength(1)
		expect(summary(request.workId).requests[0]).toEqual(existing.requests[0])
		expect(fs.readFileSync(journal, "utf8")).toBe(journalBytes)
		expect(fs.statSync(journal).mtimeMs).toBe(journalMtime)
		expect(fs.readFileSync(stamp, "utf8")).toBe(stampBytes)
	})
	it("replays unchanged version-4 ledgers to restore observations and hunk evidence", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const fileMatch = { path: "file.ts", worktree: "/project", method: "file-hunks", transitionIds: ["native-edit"] }
		appendWorkRecord(ctx, {
			type: "commit",
			sha: "a".repeat(40),
			repository: "/project/.git",
			worktree: "/project",
			fileMatches: [fileMatch],
		})
		appendWorkRecord(ctx, {
			type: "file_observation",
			observationId: "shell-window",
			toolCallId: "shell-tool",
			source: "bash",
			repository: "/project/.git",
			worktree: "/project",
			files: [],
			complete: false,
		})
		await flushWorkSummaries()
		// Model an old derived view, without modifying any captured observations.
		const backend = backendFor(dir)
		const authority = structuredClone(backend.readRecords({ workId }))
		const old = structuredClone(summary(workId))
		old.fileObservations = []
		old.commits[0].fileMatches = []
		backend.tx(() => {
			backend.clearProjection(workId)
			saveWorkSummary(dir, old)
			backend.markDirty(workId)
		})
		expect(summary(workId).fileObservations).toEqual([])
		expect(summary(workId).commits[0].fileMatches).toEqual([])
		const ledger = join(dir, "work-attribution", "parent.jsonl")
		fs.mkdirSync(dirname(ledger), { recursive: true })
		const ledgerBytes = `${authority.map((row) => row.body).join("\n")}\n`
		fs.writeFileSync(ledger, ledgerBytes)
		const past = new Date(Date.now() - 60 * 60 * 1000)
		fs.utimesSync(ledger, past, past)
		const ledgerMtime = fs.statSync(ledger).mtimeMs
		fs.mkdirSync(dirname(path(workId)), { recursive: true })
		const oldBytes = JSON.stringify({ version: 1, ...old })
		fs.writeFileSync(path(workId), oldBytes)
		const { size, mtimeMs } = fs.statSync(path(workId))
		const stamp = join(dir, "work-attribution", ".recovered.json")
		const stampBytes = JSON.stringify({
			version: 4,
			startedAt: Date.now(),
			summaries: { [workId]: `${size}:${mtimeMs}` },
		})
		fs.writeFileSync(stamp, stampBytes)
		vi.resetModules()
		const relaunched = await import("./summary.js")
		relaunched.recoverWorkSummaries()
		await relaunched.flushWorkSummaries()
		expect(summary(workId).fileObservations).toEqual([
			expect.objectContaining({ observationId: "shell-window", complete: false }),
		])
		expect(summary(workId).commits[0].fileMatches).toEqual([fileMatch])
		expect(backend.readRecords({ workId })).toEqual(authority)
		expect(backend.dirtyWorks()).not.toContain(workId)
		expect(fs.readFileSync(path(workId), "utf8")).toBe(oldBytes)
		expect(fs.statSync(path(workId)).mtimeMs).toBe(mtimeMs)
		expect(fs.readFileSync(ledger, "utf8")).toBe(ledgerBytes)
		expect(fs.statSync(ledger).mtimeMs).toBe(ledgerMtime)
		expect(fs.readFileSync(stamp, "utf8")).toBe(stampBytes)
	})
	it.each([
		undefined,
		"{",
		"null",
		"[]",
		'{"version":1,"workId":"WORK_ID","sessions":[],"requests":[null],"plans":[],"commits":[]}',
		'{"version":1,"workId":"wrong","sessions":[],"requests":[],"plans":[],"commits":[]}',
	])("imports legacy records despite a missing or invalid legacy summary (%s)", async (corrupt) => {
		const workId = randomUUID()
		const ledger = join(dir, "work-attribution", "parent.jsonl")
		const childLedger = join(dir, "work-attribution", "child.jsonl")
		fs.mkdirSync(dirname(ledger), { recursive: true })
		const parentBytes = `${JSON.stringify({ version: 1, type: "request", sessionId: "parent", workId, requestId: "old-request", provider: "test", model: "old" })}\n{"type":"request"`
		const childBytes = `${JSON.stringify({ version: 1, type: "plan", sessionId: "child", workId, path: "/old-plan.md" })}\n`
		fs.writeFileSync(ledger, parentBytes)
		fs.writeFileSync(childLedger, childBytes)
		fs.mkdirSync(dirname(path(workId)), { recursive: true })
		const legacySummary = corrupt?.replace("WORK_ID", workId)
		if (legacySummary !== undefined) fs.writeFileSync(path(workId), legacySummary)
		expect(backendFor(dir).recordCount()).toBe(0)
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const fresh = context("fresh")
		try {
			await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, fresh)
			await flushWorkSummaries()
			expect(summary(workId)).toMatchObject({
				workId,
				sessions: expect.arrayContaining(["parent", "child"]),
				requests: [expect.objectContaining({ requestId: "old-request", sessionId: "parent" })],
				plans: [expect.objectContaining({ path: "/old-plan.md", sessionId: "child" })],
			})
			expect(backendFor(dir).recordCount(workId)).toBe(2)
			expect(fs.readFileSync(ledger, "utf8")).toBe(parentBytes)
			expect(fs.readFileSync(childLedger, "utf8")).toBe(childBytes)
			if (legacySummary === undefined) expect(fs.existsSync(path(workId))).toBe(false)
			else expect(fs.readFileSync(path(workId), "utf8")).toBe(legacySummary)
			expect(fs.existsSync(join(dir, "work-attribution", ".recovered.json"))).toBe(false)
		} finally {
			await api.getHandler<SessionShutdownEvent>("session_shutdown")(
				{ type: "session_shutdown", reason: "quit" },
				fresh,
			)
		}
	})
	it("keeps a durable request header when the legacy summary directory is blocked", async () => {
		fs.writeFileSync(join(dir, "work"), "blocked")
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
		await api.getHandler<BeforeProviderHeadersEvent>("before_provider_headers")(event, context())
		const request = readWorkRecords(dir).find((row) => row.type === "request")
		if (!request) throw new Error("Expected a durable request")
		expect(event.headers["X-Request-Id"]).toBe(request.requestId)
		await flushWorkSummaries()
		expect(summary(request.workId).requests).toEqual([
			expect.objectContaining({ requestId: request.requestId, sessionId: "parent" }),
		])
		expect(fs.readFileSync(join(dir, "work"), "utf8")).toBe("blocked")
		expect(fs.existsSync(join(dir, "work-attribution", "parent.jsonl"))).toBe(false)
		expect(warn).not.toHaveBeenCalled()
	})
	it("does not scan unrelated histories for an ordinary append", async () => {
		const workId = getWorkId(context())
		await flushWorkSummaries()
		summary(workId)
		const scan = vi.spyOn(fs, "readdirSync")
		recordProviderRequest(context())
		await flushWorkSummaries()
		expect(scan).not.toHaveBeenCalled()
		expect(summary(workId).requests).toHaveLength(1)
	})
	it("discovers legacy roots once before assigning fresh work, then avoids rescanning", async () => {
		const scan = vi.spyOn(fs, "readdirSync")
		const workId = getWorkId(context("fresh"))
		await flushWorkSummaries()
		expect(scan.mock.calls.map(([source]) => String(source))).toEqual([
			join(dir, "work-attribution"),
			join(dir, "work-attribution", "transitions"),
		])
		scan.mockClear()
		const nextWorkId = getWorkId(context("next-fresh"))
		expect(nextWorkId).not.toBe(workId)
		expect(summary(workId).sessions).toEqual(["fresh"])
		expect(summary(nextWorkId).sessions).toEqual(["next-fresh"])
		expect(scan).not.toHaveBeenCalled()
	})
	it("resumes a legacy session's work at once while the rest of the history imports in the background", async () => {
		const legacy = join(dir, "work-attribution")
		fs.mkdirSync(legacy, { recursive: true })
		const works = new Map(["older", "other", "resumed"].map((sessionId) => [sessionId, randomUUID()]))
		for (const [sessionId, workId] of works)
			fs.writeFileSync(
				join(legacy, `${sessionId}.jsonl`),
				`${JSON.stringify({ version: 1, type: "work", workId, sessionId, cwd: "/project", recordedAt: "2026-10-01T00:00:00.000Z" })}\n`,
			)
		// Each journal takes longer than an import slice.
		const start = Date.now()
		let calls = 0
		vi.spyOn(Date, "now").mockImplementation(() => start + 60 * calls++)
		expect(getWorkId(context("resumed"))).toBe(works.get("resumed"))
		// The session's own journal and one slice imported before returning; the third journal waits.
		expect(backendFor(dir).recordCount()).toBe(2)
		await flushWorkSummaries()
		expect(backendFor(dir).recordCount()).toBe(3)
	})
	it("relaunches without reimporting unchanged facts or republishing their projection", async () => {
		const ctx = context()
		const workId = getWorkId(ctx)
		recordProviderRequest(ctx)
		await flushWorkSummaries()
		const backend = backendFor(dir)
		const authority = structuredClone(backend.readRecords({ workId }))
		const published = structuredClone(backend.getHead(workId))
		if (!published) throw new Error("Expected a published projection")
		const inserted = vi.spyOn(backend, "insertRecord")
		const publish = vi.spyOn(backend, "putHead")
		const launch = async () => {
			vi.resetModules()
			const relaunched = await import("./summary.js")
			const records = await import("../pr-cost-reporting/ledger/records.js")
			expect(records.backendFor(dir)).toBe(backend)
			relaunched.recoverWorkSummaries()
			await relaunched.flushWorkSummaries()
		}
		const ledger = join(dir, "work-attribution", "parent.jsonl")
		const originalBytes = `${authority.map((row) => row.body).join("\n")}\n`
		fs.mkdirSync(dirname(ledger), { recursive: true })
		fs.writeFileSync(ledger, originalBytes)
		const past = new Date(Date.now() - 60 * 60 * 1000)
		fs.utimesSync(ledger, past, past)
		const untouchedTime = fs.statSync(ledger, { bigint: true }).mtimeNs
		await launch()
		expect(backend.readRecords({ workId })).toEqual(authority)
		expect(backend.getHead(workId)).toEqual(published)
		expect(publish).not.toHaveBeenCalled()
		const cursor = structuredClone(backend.getJournalCursor(ledger))
		expect(cursor?.offset).toBe(Buffer.byteLength(originalBytes))
		inserted.mockClear()
		await launch()
		expect(inserted).not.toHaveBeenCalled()
		expect(publish).not.toHaveBeenCalled()
		expect(backend.getJournalCursor(ledger)).toEqual(cursor)
		expect(fs.statSync(ledger, { bigint: true }).mtimeNs).toBe(untouchedTime)
		expect(fs.readFileSync(ledger, "utf8")).toBe(originalBytes)

		// An old process can append after migration without updating the projection.
		fs.appendFileSync(
			ledger,
			`${JSON.stringify({ type: "request", requestId: "unpublished", version: 1, sessionId: "parent", workId, cwd: "/project", scope: null, recordedAt: new Date().toISOString() })}\n`,
		)
		const appendedBytes = fs.readFileSync(ledger, "utf8")
		await launch()
		expect(inserted).toHaveBeenCalledTimes(1)
		expect(publish).toHaveBeenCalledTimes(1)
		expect(backend.getHead(workId)).toBeDefined()
		const expectedRequests = structuredClone(backend.readLog(workId, "requests"))
		expect(expectedRequests).toHaveLength(2)
		expect(summary(workId).requests).toHaveLength(2)
		expect(summary(workId).requests).toContainEqual(expect.objectContaining({ requestId: "unpublished", scope: null }))
		const replayed = structuredClone(backend.readRecords({ workId }))
		expect(replayed.slice(0, authority.length)).toEqual(authority)
		expect(replayed).toHaveLength(authority.length + 1)

		// Missing and stale projections recover even though the imported file is unchanged.
		for (const damaged of [false, true]) {
			backend.tx(() => {
				backend.clearProjection(workId)
				if (damaged) backend.putHead({ ...published, logs: {}, latest: {} })
				backend.markDirty(workId)
			})
			expect(backend.readLog(workId, "requests")).toEqual([])
			expect(backend.getHead(workId)).toEqual(damaged ? { ...published, logs: {}, latest: {} } : undefined)
			expect(backend.dirtyWorks()).toContain(workId)
			await launch()
			expect(backend.dirtyWorks()).not.toContain(workId)
			expect(backend.getHead(workId)).toBeDefined()
			expect(backend.readLog(workId, "requests")).toEqual(expectedRequests)
			expect(summary(workId).requests).toHaveLength(2)
			expect(backend.readRecords({ workId })).toEqual(replayed)
			expect(fs.readFileSync(ledger, "utf8")).toBe(appendedBytes)
			expect(fs.existsSync(path(workId))).toBe(false)
		}
	})
	it.each(["session", "transition"])("does not checkpoint a failed %s ledger scan and retries it", async (kind) => {
		const workId = randomUUID()
		const sessionLedger = join(dir, "work-attribution", "parent.jsonl")
		const transitionLedger = join(dir, "work-attribution", "transitions", "unreadable.jsonl")
		const sessionBytes = `${JSON.stringify({ version: 1, type: "request", sessionId: "parent", workId, requestId: "captured-request", scope: null })}\n`
		const transitionBytes = `${JSON.stringify({ version: 1, type: "file_transition", sessionId: "parent", workId, transitionId: "edit", toolCallId: "tool", repository: "/repo", worktree: "/tree", path: "file.ts" })}\n`
		fs.mkdirSync(dirname(transitionLedger), { recursive: true })
		fs.writeFileSync(sessionLedger, sessionBytes)
		fs.writeFileSync(transitionLedger, transitionBytes)
		const backend = backendFor(dir)
		expect(backend.recordCount()).toBe(0)
		const ledger = kind === "session" ? sessionLedger : transitionLedger
		let failedFd: number | undefined
		const open = fs.openSync
		const opened = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
			const fd = open(...args)
			if (args[0] === ledger) failedFd = fd
			return fd
		})
		const read = fs.readSync
		const failure = vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
			if (args[0] === failedFd) throw new Error("injected ledger read failure")
			return read(...args)
		})
		const closed = vi.spyOn(fs, "closeSync")
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(failedFd).toEqual(expect.any(Number))
		expect(closed).toHaveBeenCalledWith(failedFd)
		expect(warn).toHaveBeenCalledWith(
			"Work summary recovery unavailable:",
			expect.objectContaining({ message: "injected ledger read failure" }),
		)
		expect(backend.getJournalCursor(ledger)).toBeUndefined()
		expect(backend.recordCount(workId)).toBe(kind === "session" ? 0 : 1)
		const accepted = structuredClone(backend.readRecords({ workId }))
		expect(fs.existsSync(join(dir, "work-attribution", ".recovered.json"))).toBe(false)
		failure.mockRestore()
		opened.mockRestore()
		closed.mockRestore()
		recoverWorkSummaries()
		await flushWorkSummaries()
		expect(summary(workId).requests).toEqual([expect.objectContaining({ requestId: "captured-request", scope: null })])
		expect(summary(workId).fileTransitions).toEqual([expect.objectContaining({ transitionId: "edit" })])
		expect(backend.recordCount(workId)).toBe(2)
		expect(backend.readRecords({ workId }).slice(0, accepted.length)).toEqual(accepted)
		expect(backend.getJournalCursor(ledger)?.offset).toBe(
			Buffer.byteLength(kind === "session" ? sessionBytes : transitionBytes),
		)
		expect(fs.readFileSync(sessionLedger, "utf8")).toBe(sessionBytes)
		expect(fs.readFileSync(transitionLedger, "utf8")).toBe(transitionBytes)
		expect(fs.existsSync(path(workId))).toBe(false)
	})

	it("retains an append committed after lock release before the first writer flushes", async () => {
		const workId = randomUUID()
		const first = startNative(nativeRecord(workId, "parent", "queued"), 1, true)
		let next: ReturnType<typeof startNative> | undefined
		try {
			expect(await first.next()).toBe("ready")
			expect(await first.next()).toBe("pending")
			first.child.stdin.write("c")
			expect(await first.next()).toBe("committed")
			const committed = native<NativeSummaryState>("summary-state", workId)
			expect(coherentState(committed).requests.map((row) => row.requestId)).toEqual(["queued"])
			next = startNative(nativeRecord(workId, "parent", "during-release"))
			expect(await next.next()).toBe("ready")
			expect(await next.next()).toBe("pending")
			expect(native("summary-state", workId)).toEqual(committed)
			next.child.stdin.write("c")
			expect(await next.next()).toBe("committed")
			expect(await next.next()).toBe("flushed")
			await next.done
			const appended = native<NativeSummaryState>("summary-state", workId)
			expect(coherentState(appended).requests.map((row) => row.requestId)).toEqual(["queued", "during-release"])
			expect(appended.authority.slice(0, committed.authority.length)).toEqual(committed.authority)
			first.child.stdin.write("c")
			expect(await first.next()).toBe("flushed")
			await first.done
			expect(native("summary-state", workId)).toEqual(appended)
			expect(fs.existsSync(path(workId))).toBe(false)
			expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false)
		} finally {
			await first.stop()
			await next?.stop()
		}
	}, 15000)
	it("does one legacy discovery per agent directory despite child session fanout", async () => {
		const scan = vi.spyOn(fs, "readdirSync")
		const workId = getWorkId(context())
		await flushWorkSummaries()
		const roots = [join(dir, "work-attribution"), join(dir, "work-attribution", "transitions")]
		expect(scan.mock.calls.map(([source]) => String(source))).toEqual(roots)
		for (const session of ["first", "child", "next-child"]) {
			const api = createExtensionApi()
			createWorkAttributionExtension(workId)(api.api)
			await api.getHandler<SessionStartEvent>("session_start")(
				{ type: "session_start", reason: "startup" },
				context(session),
			)
		}
		expect(scan.mock.calls.map(([source]) => String(source))).toEqual(roots)
	})

	it.each([
		"authority",
		"translation",
		"projection",
	])("preserves durable requests and retries an atomic %s failure", async (failure) => {
		const ctx = context()
		const workId = getWorkId(ctx)
		const prior = recordProviderRequest(ctx)
		const backend = backendFor(dir)
		const authority = structuredClone(backend.readRecords({ workId }))
		const head = structuredClone(backend.getHead(workId))
		const rows = structuredClone(backend.readLog(workId, "requests"))
		expect(rows).toEqual([expect.objectContaining({ requestId: prior.requestId })])
		const attempts: StoredRecord[] = []
		const insert = backend.insertRecord.bind(backend)
		const mark = backend.upsertMarker.bind(backend)
		const publish = backend.putHead.bind(backend)
		const injected = new Error(`injected ${failure} failure`)
		let mutations = 0
		vi.spyOn(backend, "insertRecord").mockImplementation((row) => {
			attempts.push(structuredClone(row))
			const inserted = insert(row)
			if (failure === "authority") {
				expect(inserted).toBe(true)
				mutations++
				throw injected
			}
			return inserted
		})
		if (failure === "translation")
			vi.spyOn(backend, "upsertMarker").mockImplementation((...args) => {
				mark(...args)
				mutations++
				throw injected
			})
		if (failure === "projection")
			vi.spyOn(backend, "putHead").mockImplementation((next) => {
				publish(next)
				expect(backend.getHead(next.workId)).toEqual(next)
				mutations++
				throw injected
			})
		const warn = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		const silence = vi.spyOn(console, "warn")
		// Capture is atomic: prior requests survive, and a failed attempt is never half-published.
		expect(tryWorkAttribution(() => recordProviderRequest(ctx))).toBeUndefined()
		expect(attempts).toHaveLength(1)
		expect(mutations).toBe(1)
		expect(backend.readRecords({ workId })).toEqual(authority)
		expect(backend.getHead(workId)).toEqual(head)
		expect(backend.readLog(workId, "requests")).toEqual(rows)
		expect(warn).toHaveBeenCalledWith("Attribution unavailable:", injected)
		expect(silence).not.toHaveBeenCalled()
		const failedWorkId = randomUUID()
		expect(
			tryWorkAttribution(() =>
				capture(
					dir,
					{
						version: 1,
						type: "work",
						workId: failedWorkId,
						sessionId: "failed-first-header",
						scope: null,
					},
					null,
				),
			),
		).toBeUndefined()
		expect(mutations).toBe(2)
		expect(backend.getHead(failedWorkId)).toBeUndefined()
		expect(backend.readRecords({ workId: failedWorkId })).toEqual([])
		expect(backend.readRecords({ workId })).toEqual(authority)
		const failed = attempts[0]
		const retry: WorkRecord = JSON.parse(failed.body)
		expect(retry).toMatchObject({ type: "request", workId, sessionId: "parent", scope: null })
		expect(retry.requestId).toEqual(expect.any(String))
		vi.restoreAllMocks()
		capture(dir, retry, failed.sourcePath)
		expect(backend.readRecords({ workId }).slice(0, authority.length)).toEqual(authority)
		expect(backend.readRecords({ workId })).toHaveLength(authority.length + 1)
		expect(backend.getHead(workId)).toBeDefined()
		expect(backend.readLog(workId, "requests")).toEqual([
			...rows,
			expect.objectContaining({ requestId: retry.requestId, scope: null }),
		])
		const recovered = structuredClone(backend.readRecords({ workId }))
		capture(dir, retry, failed.sourcePath)
		expect(backend.readRecords({ workId })).toEqual(recovered)
		expect(backend.readLog(workId, "requests")).toHaveLength(2)
		expect(fs.existsSync(path(workId))).toBe(false)
		expect(fs.existsSync(join(dir, "work-attribution", "parent.jsonl"))).toBe(false)
		const sql = native<{
			before: NativeSummaryState
			after: NativeSummaryState
			failedHeader: NativeSummaryState
			recovered: NativeSummaryState
			mutations: number
			rejected: number
		}>("summary-atomic", { record: retry, failure, failedWorkId })
		expect(sql.mutations).toBe(2)
		expect(sql.rejected).toBe(2)
		expect(sql.after).toEqual(sql.before)
		coherentState(sql.before)
		coherentState(sql.after)
		expect(sql.failedHeader).toEqual({ authority: [], markers: [], head: null, rows: [] })
		expect(coherentState(sql.recovered).requests.map((row) => row.requestId)).toEqual(["prior", retry.requestId])
		expect(sql.recovered.authority).toHaveLength(3)
	})
	it("rolls back a cancelled native publisher before a competing writer commits", async () => {
		const workId = randomUUID()
		const base = nativeRecord(workId, "seed", "shared-request")
		native("capture", base)
		const before = native<NativeSummaryState>("summary-state", workId)
		const cancelled = startNative({ ...base, type: "request_response", sessionId: "cancelled", responseId: "stale" })
		let winner: ReturnType<typeof startNative> | undefined
		try {
			expect(await cancelled.next()).toBe("ready")
			expect(await cancelled.next()).toBe("pending")
			winner = startNative({ ...base, type: "request_response", sessionId: "winner", responseId: "newer" })
			expect(await winner.next()).toBe("ready")
			expect(native<NativeSummaryState>("summary-state", workId)).toEqual(before)
			cancelled.child.stdin.write("r")
			expect(await cancelled.next()).toBe("rolled-back")
			expect(await winner.next()).toBe("pending")
			expect(native<NativeSummaryState>("summary-state", workId)).toEqual(before)
			winner.child.stdin.write("c")
			expect(await winner.next()).toBe("committed")
			expect(await winner.next()).toBe("flushed")
			await winner.done
			const committed = native<NativeSummaryState>("summary-state", workId)
			const view = coherentState(committed)
			expect(view.requests).toEqual([expect.objectContaining({ requestId: base.requestId, responseId: "newer" })])
			expect(view.sessions.map((row) => row.sessionId).sort()).toEqual(["seed", "winner"])
			expect(committed.authority).toHaveLength(2)
			expect(cancelled.child.exitCode).toBeNull()
			cancelled.child.stdin.write("c")
			await cancelled.done
			// Closing the still-live cancelled owner cannot republish its old head after the winner.
			expect(native<NativeSummaryState>("summary-state", workId)).toEqual(committed)
		} finally {
			await cancelled.stop()
			await winner?.stop()
		}
	}, 15000)
	it("recovers a killed native owner without publishing its uncommitted head", async () => {
		const workId = randomUUID()
		const base = nativeRecord(workId, "seed", "shared-request")
		native("capture", base)
		const before = native<NativeSummaryState>("summary-state", workId)
		const owner = startNative({ ...base, type: "request_response", responseId: "killed" })
		try {
			expect(await owner.next()).toBe("ready")
			expect(await owner.next()).toBe("pending")
			expect(native<NativeSummaryState>("summary-state", workId)).toEqual(before)
			owner.child.kill("SIGKILL")
			await expect(owner.done).rejects.toThrow("Native writer exited")
			expect(native<NativeSummaryState>("summary-state", workId)).toEqual(before)
			native("capture", { ...base, type: "request_response", responseId: "recovered" })
			const reopened = native<NativeSummaryState>("summary-state", workId)
			expect(coherentState(reopened).requests).toEqual([
				expect.objectContaining({ requestId: base.requestId, responseId: "recovered" }),
			])
			expect(reopened.authority).toHaveLength(2)
			expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false)
		} finally {
			await owner.stop()
		}
	}, 15000)

	it("serializes three native writers while a reader sees coherent authority, markers and projection", async () => {
		const workId = randomUUID()
		expect(native<WorkRecord[]>("records", workId)).toEqual([])
		const reader = startNativeProcess("summary-reader", workId)
		const writers: ReturnType<typeof startNative>[] = []
		const observed: number[] = []
		try {
			expect((await reader.next()).phase).toBe("ready")
			writers.push(...Array.from({ length: 3 }, (_, index) => startNative(nativeRecord(workId, `session-${index}`), 8)))
			await Promise.all(writers.map(async (writer) => expect(await writer.next()).toBe("ready")))
			await Promise.all(
				writers.map(async (writer) => {
					for (let index = 0; index < 8; index++) {
						expect(await writer.next()).toBe("pending")
						reader.child.stdin.write("read\n")
						const message = await reader.next()
						expect(message.phase).toBe("snapshot")
						if (!message.state) throw new Error("Native reader omitted its snapshot")
						observed.push(coherentState(message.state).requests.length)
						writer.child.stdin.write("c")
						expect(await writer.next()).toBe("committed")
					}
					expect(await writer.next()).toBe("flushed")
					await writer.done
				}),
			)
			const final = native<NativeSummaryState>("summary-state", workId)
			const view = coherentState(final)
			expect([...observed, view.requests.length].sort((a, b) => a - b)).toEqual(
				Array.from({ length: 25 }, (_, index) => index),
			)
			expect(view.requests.map((row) => row.requestId).sort()).toEqual(
				Array.from({ length: 3 }, (_, session) =>
					Array.from({ length: 8 }, (_, request) => `session-${session}-${request}`),
				)
					.flat()
					.sort(),
			)
			expect(view.sessions.map((row) => row.sessionId).sort()).toEqual(["session-0", "session-1", "session-2"])
			expect(final.authority).toHaveLength(24)
			expect(fs.existsSync(path(workId))).toBe(false)
			expect(fs.existsSync(join(dir, "work-attribution"))).toBe(false)
		} finally {
			await Promise.all(writers.map((writer) => writer.stop()))
			await reader.stop()
		}
	}, 15000)
})
