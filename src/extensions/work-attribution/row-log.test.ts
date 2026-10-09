import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as asyncFs from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { performance } from "node:perf_hooks"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { appendWorkRecord } from "../work-attribution.js"
import { readWorkBrowser } from "./browser.js"
import { workCostTotals } from "./cost-details.js"
import {
	COLLECTIONS,
	type Collection,
	commitPullRequests,
	logPath,
	ROW_KEYS,
	readWorkHead,
	readWorkRows,
	readWorkSummary,
	summaryLatest,
	type WorkHead,
	type WorkSummaryView,
} from "./row-log.js"
import { flushWorkSummaries, mergeWorkRecords, updateWorkSummary, type WorkRecord } from "./summary.js"

vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof asyncFs>()) }))
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

let dir: string
beforeEach(() => {
	dir = fs.mkdtempSync(join(tmpdir(), "kimchi-row-log-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(async () => {
	await flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	fs.rmSync(dir, { recursive: true, force: true })
})

const BASE = Date.parse("2026-10-01T00:00:00.000Z")
const iso = (at: number) => new Date(at).toISOString()
function folder(workId: string): string {
	return join(dir, "work", workId)
}
function manifest(workId: string): WorkHead {
	return JSON.parse(fs.readFileSync(join(folder(workId), "work.json"), "utf8"))
}
function writeVersionOne(summary: WorkSummaryView): void {
	fs.mkdirSync(folder(summary.workId), { recursive: true })
	fs.writeFileSync(join(folder(summary.workId), "work.json"), `${JSON.stringify(summary, null, 2)}\n`)
}
function fixture(name: string): WorkSummaryView {
	return JSON.parse(fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"))
}
function emptySummary(workId: string): WorkSummaryView {
	return {
		version: 1,
		workId,
		sessions: [],
		workLinks: [],
		requests: [],
		plans: [],
		commits: [],
		fileTransitions: [],
		fileObservations: [],
		continuations: [],
	}
}
/** The version 1 shape with every collection, in the order the row logs fold into. */
function withDefaults(value: WorkSummaryView): WorkSummaryView {
	const empty = emptySummary(value.workId)
	return {
		...empty,
		sessions: value.sessions,
		...Object.fromEntries(COLLECTIONS.map((collection) => [collection, value[collection] ?? []])),
	}
}

/** How version 1 applied a batch: parse the whole summary, merge in memory, serialize it again. */
async function versionOneUpdate(summary: WorkSummaryView, records: WorkRecord[]): Promise<WorkSummaryView> {
	const copy = withDefaults(JSON.parse(JSON.stringify(summary)))
	const keyed = (collection: Collection) => new Map(copy[collection].map((row) => [ROW_KEYS[collection](row), row]))
	const rows = {
		sessions: new Set(copy.sessions),
		workLinks: keyed("workLinks"),
		requests: keyed("requests"),
		plans: keyed("plans"),
		commits: keyed("commits"),
		fileTransitions: keyed("fileTransitions"),
		fileObservations: keyed("fileObservations"),
		continuations: keyed("continuations"),
	}
	await mergeWorkRecords(rows, structuredClone(records))
	return JSON.parse(
		JSON.stringify({
			version: 1,
			workId: copy.workId,
			sessions: [...rows.sessions],
			...Object.fromEntries(COLLECTIONS.map((collection) => [collection, [...rows[collection].values()]])),
		}),
	)
}

/** Feeds one batch through the real summary writer, as records appended in one tick are. */
async function apply(records: WorkRecord[]): Promise<void> {
	for (const record of structuredClone(records)) updateWorkSummary(record)
	await flushWorkSummaries()
}

/** The committed files match the expected version 1 view, and no stray row file is left. */
function expectCommitted(workId: string, expected: WorkSummaryView, { latest = true } = {}): WorkHead {
	const head = manifest(workId)
	expect(head.version).toBe(2)
	expect(JSON.stringify(readWorkSummary(dir, workId))).toBe(JSON.stringify(expected))
	const named: string[] = []
	for (const collection of COLLECTIONS) {
		const log = head.logs[collection]
		if (!log) {
			expect(expected[collection]).toEqual([])
			continue
		}
		const path = logPath(folder(workId), collection, log.generation)
		named.push(basename(path))
		const bytes = fs.readFileSync(path)
		expect(bytes.length).toBe(log.bytes)
		expect(bytes[log.bytes - 1]).toBe(10)
		expect(log.rows).toBe(expected[collection].length)
	}
	expect(fs.readdirSync(join(folder(workId), "rows")).sort()).toEqual(named.sort())
	expect(head.sessions).toEqual(expected.sessions)
	expect(head.pullRequests).toEqual(commitPullRequests(expected.commits))
	if (latest) expect(head.latest).toEqual(summaryLatest((collection) => expected[collection]).latest)
	return head
}

/** Deterministic records over every type, with repeated keys, PR updates, billing unions and replays. */
function randomRecords(seed: number, workId: string, count: number, { replays = false, large = false } = {}) {
	let state = seed
	const random = () => {
		state = (state + 0x6d2b79f5) | 0
		let value = Math.imul(state ^ (state >>> 15), 1 | state)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
	const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
	const requestIds = Array.from({ length: 12 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-1111`)
	const started = new Map<string, string>()
	const billingRows = [
		{ id: "row-a", costUsd: "0.1" },
		{ id: "row-a", costUsd: "0.1", promptTokens: "10" },
		{ id: "row-b", costUsd: null },
	]
	const records: WorkRecord[] = []
	for (let index = 0; index < count; index++) {
		const at = BASE + index * 1000
		if (replays && records.length && random() < 0.15) {
			records.push(structuredClone(pick(records)))
			continue
		}
		const base = { version: 1 as const, workId, sessionId: pick(["s1", "s2", "s3"]), cwd: "/tree", recordedAt: iso(at) }
		const requestId = pick(requestIds)
		const startedAt = started.get(requestId) ?? iso(at)
		started.set(requestId, startedAt)
		const type = pick([
			"work",
			"work_link",
			"request",
			"request",
			"request_dispatch",
			"request_response",
			"request_cost",
			"request_cost",
			"plan",
			"commit",
			"commit",
			"file_transition",
			"file_observation",
		] as const)
		switch (type) {
			case "work":
				records.push({
					...base,
					type,
					...(random() < 0.6
						? {
								continuation: {
									source: pick(["recent-branch", "named-artifact"]),
									evidence: { path: pick(["/a.md", "/b.md"]) },
								},
							}
						: { segment: { id: randomUUID(), attribution: "explicit", reason: "work-command" } }),
				})
				break
			case "work_link":
				records.push({
					...base,
					type,
					linkId: pick(["link-1", "link-2"]),
					revision: pick([1, 2]),
					sourceWorkId: workId,
					targetWorkId: workId,
					requestIds: [requestId],
					scope: { repository: "/repo/.git" },
					status: pick(["active", "revoked"]),
					evidence: { source: "work-command" },
				})
				break
			case "request":
				records.push({
					...base,
					type,
					requestId,
					startedAt,
					model: pick(["a", "b"]),
					scope: { repository: pick(["/repo/.git", "/other/.git"]) },
					...(large && requestIds.indexOf(requestId) < 3 ? { note: "x".repeat(60_000) } : {}),
				})
				break
			case "request_dispatch":
				records.push({ ...base, type, requestId, startedAt, dispatchedAt: iso(at + 3), billingTagSkipped: "fixture" })
				break
			case "request_response":
				records.push({
					...base,
					type,
					requestId,
					startedAt,
					response: { status: pick([200, 503]), receivedAt: iso(at) },
				})
				break
			case "request_cost":
				records.push({
					...base,
					type,
					requestId,
					billingRows: billingRows.filter(() => random() < 0.5),
					billingLookup: {
						status: pick(["priced", "pending"]),
						checkedAt: pick([iso(at), iso(at - 50_000), "invalid"]),
					},
				})
				break
			case "plan":
				records.push({
					...base,
					type,
					path: pick(["/tree/.kimchi/plans/a.md", "/tree/.kimchi/plans/b.md"]),
					snapshotPath: pick(["/work/plans/a-1.md", "/work/plans/a-2.md", "/work/plans/b-1.md"]),
				})
				break
			case "commit": {
				const number = pick([7, 8])
				records.push({
					...base,
					type,
					sha: pick(["a", "b", "c", "d"]).repeat(40),
					repository: pick(["/repo/.git", "/other/.git"]),
					worktree: "/tree",
					...(random() < 0.5
						? {
								pullRequests: [
									{
										provider: "github",
										host: "github.com",
										id: `70${number}`,
										url: `https://github.com/example/kimchi/pull/${number}`,
										number,
										state: pick(["open", "merged"]),
										checkedAt: iso(at - Math.floor(random() * 5) * 1000),
									},
								],
								prLookup: { status: "linked", checkedAt: iso(at) },
							}
						: {}),
					...(random() < 0.5
						? {
								fileMatches: [
									{
										path: pick(["a.ts", "b.ts"]),
										worktree: "/tree",
										method: pick(["file-chain", "path-blob", "file-hunks"]),
										transitionIds: [pick(["t1", "t2", "t3"])],
									},
								],
							}
						: {}),
					...(random() < 0.5 ? { paths: [pick(["a.ts", "b.ts"])], transitionIds: [pick(["t1", "t2"])] } : {}),
				})
				break
			}
			case "file_transition":
				records.push({
					...base,
					type,
					transitionId: pick(["t1", "t2", "t3", "t4", "t5"]),
					toolCallId: "call",
					repository: pick(["/repo/.git", "/other/.git"]),
					worktree: "/tree",
					path: "a.ts",
					...(random() < 0.7 ? { branch: pick(["main", "feat/x"]) } : {}),
				})
				break
			case "file_observation":
				records.push({
					...base,
					type,
					observationId: pick(["o1", "o2"]),
					toolCallId: "call",
					repository: "/repo/.git",
					worktree: "/tree",
					source: "bash",
					files: [{ path: pick(["a.ts", "b.ts"]) }],
					complete: random() < 0.5,
				})
				break
		}
	}
	const batches: WorkRecord[][] = []
	for (let index = 0; index < records.length; ) {
		const size = 1 + Math.floor(random() * 6)
		batches.push(records.slice(index, index + size))
		index += size
	}
	return batches
}

describe("version 1 summaries", () => {
	it.each([
		"work-summary-v1.7.1.json",
		"work-summary-v1-stack.json",
		"work-summary-v1-legacy.json",
	])("reads %s unchanged and migrates it on the next update", async (name) => {
		const saved = fixture(name)
		writeVersionOne(saved)
		const { workId } = saved
		expect(readWorkSummary(dir, workId)).toEqual(withDefaults(saved))
		expect(readWorkRows(dir, workId, "commits")).toEqual(saved.commits)
		const head = await readWorkHead(dir, workId)
		expect(head).toMatchObject({ version: 2, logs: { requests: { rows: saved.requests.length } } })
		const existing = saved.requests[0]
		const batch: WorkRecord[] = [
			{
				version: 1,
				type: "request_response",
				workId,
				sessionId: existing.sessionId,
				requestId: String(existing.requestId),
				response: { status: 200, receivedAt: "2026-10-08T12:00:00.000Z" },
				recordedAt: "2026-10-08T12:00:00.000Z",
			},
			{
				version: 1,
				type: "request",
				workId,
				sessionId: "new-session",
				requestId: "new-request",
				startedAt: "2026-10-08T12:00:01.000Z",
				recordedAt: "2026-10-08T12:00:01.000Z",
			},
		]
		await apply(batch)
		const expected = await versionOneUpdate(saved, batch)
		expectCommitted(workId, expected)
		expect(readWorkSummary(dir, workId)?.requests.at(-1)).toMatchObject({ requestId: "new-request" })
	})

	it("reads a version 1 summary that grew past the listing limit only as too large", async () => {
		const saved = fixture("work-summary-v1.7.1.json")
		writeVersionOne(saved)
		expect(await readWorkHead(dir, saved.workId, 100)).toBe("too-large")
		expect(readWorkSummary(dir, saved.workId)).toEqual(withDefaults(saved))
	})
})

describe("row logs", () => {
	it.each<[number, { replays?: boolean; large?: boolean }]>([
		[1, {}],
		[2, { replays: true }],
		[3, { large: true }],
		[4, { replays: true, large: true }],
	])(
		"fold to the version 1 merge of random records (seed %i, %o)",
		async (seed, options) => {
			const workId = randomUUID()
			const batches = randomRecords(seed, workId, 360, options)
			let expected = await versionOneUpdate(emptySummary(workId), batches.slice(0, 5).flat())
			writeVersionOne(expected)
			let compactions = 0
			let previous: WorkHead | undefined
			for (const [index, batch] of batches.slice(5).entries()) {
				let migrated = !previous
				if (index === 30) {
					// An older release rewrote the summary as version 1; its logs are left behind.
					writeVersionOne(expected)
					migrated = true
				}
				await apply(batch)
				expected = await versionOneUpdate(expected, batch)
				const generations = (head?: WorkHead) =>
					COLLECTIONS.map((collection) => head?.logs[collection]?.generation ?? 0)
				// Replayed older records can move a row's time back; /work keeps the newer value until a recompute.
				const head = expectCommitted(workId, expected, { latest: !options.replays || migrated })
				const advanced = generations(head).some((generation, at) => generation > generations(previous)[at])
				if (advanced && !migrated && previous) {
					compactions++
					// Compaction recomputes what /work lists from every row.
					expect(head.latest).toEqual(summaryLatest((collection) => expected[collection]).latest)
				}
				previous = head
			}
			if (options.large) expect(compactions).toBeGreaterThan(0)
		},
		60_000,
	)

	it("ignores an interrupted append and drops it on the next update", async () => {
		const workId = randomUUID()
		const [first, second] = randomRecords(5, workId, 40)
			.flat()
			.reduce<WorkRecord[][]>(
				(halves, record, index) => {
					halves[index < 20 ? 0 : 1].push(record)
					return halves
				},
				[[], []],
			)
		await apply(first)
		const expected = await versionOneUpdate(emptySummary(workId), first)
		const head = manifest(workId)
		for (const collection of COLLECTIONS) {
			const log = head.logs[collection]
			if (log)
				fs.appendFileSync(logPath(folder(workId), collection, log.generation), '{"sessionId":"cut","requestId":"x')
		}
		expect(readWorkSummary(dir, workId)).toEqual(expected)
		await apply(second)
		expectCommitted(workId, await versionOneUpdate(expected, second))
	})

	it.each(["missing", "short", "garbled"])("rebuilds a work from its journals when a log is %s", async (damage) => {
		const ctx = createContext({ cwd: "/project", sessionManager: { getSessionId: () => "journal" } })
		const workId = randomUUID()
		for (let index = 0; index < 5; index++)
			appendWorkRecord(ctx, { type: "request", requestId: `request-${index}`, startedAt: iso(BASE + index) }, workId)
		appendWorkRecord(
			ctx,
			{ type: "commit", sha: "a".repeat(40), repository: "/project/.git", worktree: "/project" },
			workId,
		)
		await flushWorkSummaries()
		const before = readWorkSummary(dir, workId)
		const log = manifest(workId).logs.requests
		if (!log) throw new Error("requests were not saved")
		const path = logPath(folder(workId), "requests", log.generation)
		if (damage === "missing") fs.rmSync(path)
		if (damage === "short") fs.truncateSync(path, log.bytes - 5)
		if (damage === "garbled") fs.writeFileSync(path, "x".repeat(log.bytes))
		// Readers report damage instead of a partial work.
		expect(readWorkSummary(dir, workId)).toBeUndefined()
		appendWorkRecord(ctx, { type: "request", requestId: "after-damage" }, workId)
		await flushWorkSummaries()
		const rebuilt = readWorkSummary(dir, workId)
		expect(rebuilt?.requests.map((row) => row.requestId)).toEqual([
			...(before?.requests.map((row) => row.requestId) ?? []),
			"after-damage",
		])
		expect(rebuilt?.commits).toEqual(before?.commits)
		expect(manifest(workId).logs.requests?.generation).toBeGreaterThan(log.generation)
		expect(fs.readdirSync(join(folder(workId), "rows"))).not.toContain(basename(path))
	})

	it("rebuilds from the journals when work.json is deleted and removes the old logs", async () => {
		const ctx = createContext({ cwd: "/project", sessionManager: { getSessionId: () => "journal" } })
		const workId = randomUUID()
		appendWorkRecord(ctx, { type: "request", requestId: "kept" }, workId)
		await flushWorkSummaries()
		const old = fs.readdirSync(join(folder(workId), "rows"))
		fs.rmSync(join(folder(workId), "work.json"))
		appendWorkRecord(ctx, { type: "request", requestId: "next" }, workId)
		await flushWorkSummaries()
		expect(readWorkSummary(dir, workId)?.requests.map((row) => row.requestId)).toEqual(["kept", "next"])
		expect(fs.readdirSync(join(folder(workId), "rows")).some((name) => old.includes(name))).toBe(false)
	})

	it("removes a compacted generation that a crash left uncommitted", async () => {
		const workId = randomUUID()
		const batches = randomRecords(3, workId, 300, { large: true })
		const records = batches.flat()
		const original = asyncFs.rename
		let renames = 0
		// The second rename of an update is the compaction's manifest: fail it once, like a crash would.
		vi.spyOn(asyncFs, "rename").mockImplementation(async (...args) => {
			if (String(args[1]).endsWith("work.json") && ++renames === 2) throw new Error("injected crash")
			return original(...args)
		})
		let expected = emptySummary(workId)
		for (const batch of batches) {
			renames = 0
			await apply(batch)
			expected = await versionOneUpdate(expected, batch)
			if (fs.readdirSync(join(folder(workId), "rows")).length > Object.keys(manifest(workId).logs).length) break
		}
		const stray = fs
			.readdirSync(join(folder(workId), "rows"))
			.filter(
				(name) =>
					!Object.entries(manifest(workId).logs).some(
						([collection, log]) => name === `${collection}.${log.generation}.jsonl`,
					),
			)
		expect(stray).toHaveLength(1)
		// Committed rows survive; only the uncommitted copy is extra.
		expect(JSON.stringify(readWorkSummary(dir, workId))).toBe(JSON.stringify(expected))
		vi.mocked(asyncFs.rename).mockRestore()
		const next = records.slice(0, 1)
		await apply(next)
		expectCommitted(workId, await versionOneUpdate(expected, next))
	}, 60_000)

	it("starts a fresh generation after an older release rewrote the summary as version 1", async () => {
		const workId = randomUUID()
		const [first, ...rest] = randomRecords(6, workId, 30)
		await apply(first)
		const old = manifest(workId)
		const expected = await versionOneUpdate(emptySummary(workId), first)
		writeVersionOne(expected)
		const next = rest.flat()
		await apply(next)
		const head = expectCommitted(workId, await versionOneUpdate(expected, next))
		for (const collection of COLLECTIONS) {
			const generation = old.logs[collection]?.generation
			if (generation) expect(head.logs[collection]?.generation).toBeGreaterThan(generation)
		}
	})

	it("rereads the manifest once when a compaction replaces a log during a read", async () => {
		const workId = randomUUID()
		const [batch] = randomRecords(7, workId, 40)
		await apply(batch)
		const expected = readWorkSummary(dir, workId)
		const head = manifest(workId)
		const collection = COLLECTIONS.find((name) => head.logs[name])
		if (!collection) throw new Error("nothing was saved")
		const log = head.logs[collection]
		if (!log) throw new Error("nothing was saved")
		const old = logPath(folder(workId), collection, log.generation)
		const original = fs.openSync
		let replaced = false
		vi.spyOn(fs, "openSync").mockImplementation((...args) => {
			if (!replaced && String(args[0]) === old) {
				replaced = true
				// What a compaction does between a reader's manifest read and its log open.
				fs.copyFileSync(old, logPath(folder(workId), collection, log.generation + 1))
				const next = { ...head, logs: { ...head.logs, [collection]: { ...log, generation: log.generation + 1 } } }
				fs.writeFileSync(join(folder(workId), "work.json"), JSON.stringify(next))
				fs.rmSync(old)
			}
			return original(...args)
		})
		expect(readWorkSummary(dir, workId)).toEqual(expected)
		expect(replaced).toBe(true)
	})

	it("never shows a partial work to a reader polling while another process appends and compacts", async () => {
		const workId = randomUUID()
		const batches = randomRecords(8, workId, 300, { large: true })
		const input = join(dir, "batches.json")
		fs.writeFileSync(input, JSON.stringify(batches))
		const script = join(dir, "writer.mts")
		fs.writeFileSync(
			script,
			`import { readFileSync } from "node:fs";
const { flushWorkSummaries, updateWorkSummary } = await import(${JSON.stringify(new URL("./summary.ts", import.meta.url).pathname)});
for (const batch of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
	for (const record of batch) updateWorkSummary(record);
	await flushWorkSummaries();
}`,
		)
		const child = spawn(process.execPath, ["--import", "tsx", script, input], {
			env: { ...process.env, PI_CODING_AGENT_DIR: dir },
		})
		let errors = ""
		child.stderr.on("data", (chunk) => {
			errors += chunk
		})
		const failures: string[] = []
		let reads = 0
		let requests = 0
		const reading = setInterval(() => {
			if (!fs.existsSync(join(folder(workId), "work.json"))) return
			const view = readWorkSummary(dir, workId)
			reads++
			if (!view) failures.push("unreadable")
			else if (view.requests.length < requests) failures.push("requests went missing")
			else requests = view.requests.length
		}, 1)
		try {
			expect(await new Promise((resolve) => child.once("exit", resolve)), errors).toBe(0)
		} finally {
			clearInterval(reading)
			child.kill()
		}
		expect(failures).toEqual([])
		expect(reads).toBeGreaterThan(10)
		let expected = emptySummary(workId)
		for (const batch of batches) expected = await versionOneUpdate(expected, batch)
		const head = expectCommitted(workId, expected)
		expect(COLLECTIONS.some((collection) => (head.logs[collection]?.generation ?? 0) > 1)).toBe(true)
	}, 60_000)

	it("notices another process's appends and compactions before appending again", async () => {
		const workId = randomUUID()
		const batches = randomRecords(9, workId, 300, { large: true })
		await apply(batches[0])
		let expected = await versionOneUpdate(emptySummary(workId), batches[0])
		// A second module instance has its own cached positions, like another Kimchi process.
		vi.resetModules()
		const other = await import("./summary.js")
		const before = manifest(workId)
		for (const batch of batches.slice(1, -1)) {
			for (const record of structuredClone(batch)) other.updateWorkSummary(record)
			await other.flushWorkSummaries()
			expected = await versionOneUpdate(expected, batch)
		}
		const changed = manifest(workId)
		expect(
			COLLECTIONS.some((name) => (changed.logs[name]?.generation ?? 0) > (before.logs[name]?.generation ?? 0)),
		).toBe(true)
		const last = batches.at(-1) ?? []
		await apply(last)
		expectCommitted(workId, await versionOneUpdate(expected, last))
	}, 60_000)
})

/** A billed request row as the stack writes it: about 2.2 KB of compact JSON. */
function billedRequest(index: number, sessionId: string) {
	const requestId = randomUUID()
	const at = iso(BASE + index * 60_000)
	return {
		requestId,
		sessionId,
		cwd: "/Users/someone/src/an-example-repository-name-worktree",
		startedAt: at,
		provider: "kimchi-dev",
		model: "glm-5.3",
		modelSource: "context",
		segment: { id: randomUUID(), attribution: "inferred", reason: "semantic-continue" },
		scope: {
			account: { apiUrl: "https://api.example.ai/v1", organizationId: randomUUID(), userId: randomUUID() },
			repository: "/Users/someone/src/an-example-repository-name/.git",
		},
		recordedAt: at,
		dispatchedAt: at,
		billingSource: {
			apiUrl: "https://api.example.ai/v1",
			gatewayUrl: "https://llm.example.ai/openai/v1/chat/completions",
			credentialHash: "e".repeat(64),
		},
		billingSelector: { type: "tag", tag: `kimchi-request:${requestId}`, startTime: at, endTime: at },
		response: { status: 200, receivedAt: at, traceId: "f".repeat(32) },
		billingRows: [
			{
				id: randomUUID(),
				costUsd: "0.00123456",
				promptPrice: "0.0011234",
				completionPrice: "0.000123",
				cacheReadPrice: "0.00001234",
				cacheCreationPrice: "0",
				originalTotalPrice: "0.00123456",
				recommendedTotalPrice: "0",
				promptTokens: "12345",
				completionTokens: "123",
				totalTokens: "12468",
				cacheReadInputTokens: "1234",
				provider: "kimchi-dev",
				model: "glm-5.3",
				originalModel: "glm-5.3",
				responseStatusCode: 200,
				contextWindowSize: 1048576,
				createTime: at,
			},
		],
		billingLookup: { status: "priced", checkedAt: at, organizationId: randomUUID(), userId: randomUUID() },
	}
}

describe("a large work", () => {
	it("updates 20,000 requests in bounded time and bytes, reading one line per changed row", async () => {
		const workId = randomUUID()
		const sessions = Array.from({ length: 200 }, () => randomUUID())
		const summary = emptySummary(workId)
		summary.sessions = sessions
		summary.requests = Array.from({ length: 20_000 }, (_, index) => billedRequest(index, sessions[index % 200]))
		summary.commits = Array.from({ length: 200 }, (_, index) => ({
			sha: index.toString(16).padStart(40, "0"),
			repository: "/repo/.git",
			worktree: "/tree",
			sessionId: sessions[0],
			recordedAt: iso(BASE + index * 3_600_000),
		}))
		writeVersionOne(summary)
		const record = (index: number): WorkRecord => ({
			version: 1,
			type: "request",
			workId,
			sessionId: sessions[0],
			requestId: randomUUID(),
			startedAt: iso(BASE + (20_000 + index) * 60_000),
			recordedAt: iso(BASE + (20_000 + index) * 60_000),
		})
		await apply([record(0)])
		expect(manifest(workId).logs.requests?.rows).toBe(20_001)

		const logBytes = () =>
			COLLECTIONS.reduce((sum, collection) => {
				const log = manifest(workId).logs[collection]
				return sum + (log ? fs.statSync(logPath(folder(workId), collection, log.generation)).size : 0)
			}, 0)
		let read = 0
		const rows = join(folder(workId), "rows")
		const readSync = fs.readSync
		vi.spyOn(fs, "readSync").mockImplementation((...args) => {
			const bytes = readSync(...args)
			read += bytes
			return bytes
		})
		const open = asyncFs.open
		vi.spyOn(asyncFs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args)
			if (String(args[0]).startsWith(rows)) {
				const original = handle.read.bind(handle)
				vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
					const result = await original(...readArgs)
					read += result.bytesRead
					return result
				})
			}
			return handle
		})
		const times: number[] = []
		const appended: number[] = []
		for (let index = 1; index <= 20; index++) {
			const before = logBytes()
			const middle = summary.requests[index * 997]
			const batch: WorkRecord[] =
				index % 2
					? [record(index)]
					: [
							{
								version: 1,
								type: "request_cost",
								workId,
								sessionId: middle.sessionId,
								requestId: middle.requestId,
								billingLookup: { status: "priced", checkedAt: iso(BASE + 10 ** 9 + index) },
								recordedAt: iso(BASE + 10 ** 9 + index),
							},
						]
			const started = performance.now()
			await apply(batch)
			times.push(performance.now() - started)
			appended.push(logBytes() - before)
		}
		const median = [...times].sort((left, right) => left - right)[10]
		expect(median).toBeLessThan(50)
		expect(Math.max(...appended)).toBeLessThanOrEqual(8 * 1024)
		expect(fs.statSync(join(folder(workId), "work.json")).size).toBeLessThanOrEqual(16 * 1024)
		// No ordinary update scans a log: only the line of each changed row is read.
		expect(read).toBeLessThan(20 * 8 * 1024)

		vi.mocked(asyncFs.open).mockClear()
		vi.mocked(fs.readSync).mockClear()
		const opened = vi.spyOn(fs, "openSync")
		const started = performance.now()
		const head = await readWorkHead(dir, workId)
		expect(performance.now() - started).toBeLessThan(5)
		expect(head).toMatchObject({ version: 2, logs: { requests: { rows: 20_011 } } })
		expect(opened).not.toHaveBeenCalled()
		expect(vi.mocked(asyncFs.open)).not.toHaveBeenCalled()
		expect(vi.mocked(fs.readSync)).not.toHaveBeenCalled()

		// The /work browser lists it from the manifest and the bounded cost totals alone.
		const priced = summary.requests.map((row) => ({
			requestId: row.requestId,
			workIds: [workId],
			priceStatus: "priced",
			knownCostUsd: "0.001234560",
		}))
		fs.writeFileSync(
			join(folder(workId), "cost-totals.json"),
			JSON.stringify(workCostTotals({ workId, pullRequests: [], requests: priced })),
		)
		const browser = await readWorkBrowser(dir, { workId, lines: [] })
		expect(browser.rows[0].value).toBe("$24.69 known so far · no PR")
		expect(browser.rows[0].description).toContain("· 20011 requests")
		expect(opened).not.toHaveBeenCalled()
		expect(vi.mocked(fs.readSync)).not.toHaveBeenCalled()
	}, 120_000)

	it("scans a log that a restarted process leaves unchanged once, not on every update", async () => {
		const workId = randomUUID()
		await apply(
			Array.from({ length: 2000 }, (_, index) => ({
				version: 1,
				type: "file_transition",
				workId,
				sessionId: "edits",
				transitionId: `transition-${index}`,
				toolCallId: "call",
				repository: "/repo/.git",
				worktree: "/tree",
				path: `src/file-${index}.ts`,
				recordedAt: iso(BASE + index * 1000),
			})),
		)
		const edits = manifest(workId).logs.fileTransitions
		if (!edits) throw new Error("edits were not saved")
		// A new module instance has no cached positions, like Kimchi after a restart.
		vi.resetModules()
		const restarted = await import("./summary.js")
		const syncFs = await import("node:fs")
		const promises = await import("node:fs/promises")
		const request = (index: number): WorkRecord => ({
			version: 1,
			type: "request",
			workId,
			sessionId: "requests",
			requestId: `request-${index}`,
			startedAt: iso(BASE + 10 ** 7 + index),
			recordedAt: iso(BASE + 10 ** 7 + index),
		})
		// The first update reads every committed log once.
		restarted.updateWorkSummary(request(0))
		await restarted.flushWorkSummaries()

		let read = 0
		const readSync = syncFs.readSync
		vi.spyOn(syncFs, "readSync").mockImplementation((...args) => {
			const bytes = readSync(...args)
			read += bytes
			return bytes
		})
		const open = promises.open
		vi.spyOn(promises, "open").mockImplementation(async (...args) => {
			const handle = await open(...args)
			const original = handle.read.bind(handle)
			vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
				const result = await original(...readArgs)
				read += result.bytesRead
				return result
			})
			return handle
		})
		for (let index = 1; index <= 10; index++) {
			restarted.updateWorkSummary(request(index))
			await restarted.flushWorkSummaries()
		}

		expect(read).toBeLessThan(edits.bytes)
		expect(manifest(workId).logs.requests?.rows).toBe(11)
	})
})
