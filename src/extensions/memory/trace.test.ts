import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TRACE_DRAINS_KEPT, TRACE_RECALLS_KEPT } from "./config.js"
import {
	createRecallRecorder,
	createTraceRecorder,
	listRecallFiles,
	listTraceFiles,
	pruneRecallTraces,
	pruneTraceBudget,
	pruneTraces,
	readDrainEvents,
	readTraceEvents,
	resolveRecallFile,
	resolveTraceFile,
	traceDrainKeep,
	traceRecallKeep,
	tracesDir,
} from "./trace.js"

// Trace paths resolve from HOME (via defaultMemoryDir) — an isolated temp
// home keeps the suite off the developer's real traces.
const realHome = process.env.HOME
const realTrimEnv = process.env.KIMCHI_MEMORY_TRACE_DRAINS
const realRecallEnv = process.env.KIMCHI_MEMORY_TRACE_RECALLS
let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kimchi-memory-trace-"))
	process.env.HOME = home
	delete process.env.KIMCHI_MEMORY_TRACE_DRAINS
	delete process.env.KIMCHI_MEMORY_TRACE_RECALLS
})

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME
	else process.env.HOME = realHome
	if (realTrimEnv === undefined) delete process.env.KIMCHI_MEMORY_TRACE_DRAINS
	else process.env.KIMCHI_MEMORY_TRACE_DRAINS = realTrimEnv
	if (realRecallEnv === undefined) delete process.env.KIMCHI_MEMORY_TRACE_RECALLS
	else process.env.KIMCHI_MEMORY_TRACE_RECALLS = realRecallEnv
	rmSync(home, { recursive: true, force: true })
})

const drainName = (suffix: string) => `drain-2026-11-12T09-41-0${suffix}-1234.jsonl`

describe("traceDrainKeep", () => {
	it("defaults to TRACE_DRAINS_KEPT when the env var is unset", () => {
		expect(traceDrainKeep()).toBe(TRACE_DRAINS_KEPT)
	})

	it("honors KIMCHI_MEMORY_TRACE_DRAINS, including 0 = off", () => {
		process.env.KIMCHI_MEMORY_TRACE_DRAINS = "3"
		expect(traceDrainKeep()).toBe(3)
		process.env.KIMCHI_MEMORY_TRACE_DRAINS = "0"
		expect(traceDrainKeep()).toBe(0)
	})

	it("falls back to the default on garbage input", () => {
		process.env.KIMCHI_MEMORY_TRACE_DRAINS = "lots"
		expect(traceDrainKeep()).toBe(TRACE_DRAINS_KEPT)
		process.env.KIMCHI_MEMORY_TRACE_DRAINS = "-5"
		expect(traceDrainKeep()).toBe(TRACE_DRAINS_KEPT)
	})
})

describe("createTraceRecorder", () => {
	it("appends newline-terminated JSON events, ts stamped at emit", async () => {
		const recorder = createTraceRecorder()
		expect(recorder).not.toBeNull()
		expect(recorder?.file).toContain(`${tracesDir()}${"/drain-"}`)
		expect(recorder?.file.endsWith(".jsonl")).toBe(true)
		recorder?.emit({ type: "drain_start", pid: 1 })
		recorder?.emit({ type: "phase", phase: "store-add", fact: "hello" })
		await recorder?.flush?.()
		const events = readTraceEvents(recorder?.file as string)
		expect(events.map((e) => e.type)).toEqual(["drain_start", "phase"])
		for (const event of events) {
			expect(typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts))).toBe(true)
		}
		expect(events[1]?.phase).toBe("store-add")
	})

	it("keeps raw API text only in full mode", async () => {
		const compact = createTraceRecorder({ redact: false })
		compact?.emit({
			type: "api",
			request: { model: "m", system: "private context" },
			response: { content: "private answer" },
		})
		await compact?.flush?.()
		const compactEvents = readTraceEvents(compact?.file as string)
		expect(compactEvents[0]?.request).toMatchObject({ model: "m", requestBytes: expect.any(Number) })
		expect(compactEvents[0]?.response).toMatchObject({ responseBytes: expect.any(Number) })
		expect(JSON.stringify(compactEvents)).not.toContain("private context")
		expect(JSON.stringify(compactEvents)).not.toContain("private answer")

		const raw = createTraceRecorder({ rawExchanges: true, redact: false })
		raw?.emit({
			type: "api",
			request: { model: "m", system: "private context" },
			response: { content: "private answer" },
		})
		await raw?.flush?.()
		const rawEvents = readTraceEvents(raw?.file as string)
		expect((rawEvents[0]?.request as Record<string, unknown>).system).toBe("private context")
		expect((rawEvents[0]?.response as Record<string, unknown>).content).toBe("private answer")
	})

	it("rotates partitioned files by bytes while preserving valid JSONL", async () => {
		const recorder = createTraceRecorder({ rawExchanges: true, maxFileBytes: 1024 })
		for (let i = 0; i < 20; i++) recorder?.emit({ type: "phase", job: `job-${i}.json`, phase: "store-add" })
		await recorder?.flush?.()
		await vi.waitFor(() => expect(listTraceFiles().length).toBeGreaterThan(0), { timeout: 2_000 })
		const files = listTraceFiles()
		expect(files).toHaveLength(1)
		await vi.waitFor(() => expect(readDrainEvents(files[0] as string)).toHaveLength(20), { timeout: 2_000 })
		const partitions = readdirSync(tracesDir()).filter((name) => name.endsWith(".jsonl"))
		expect(partitions.length).toBeGreaterThan(1)
		for (const name of partitions) {
			expect(statSync(join(tracesDir(), name)).size).toBeLessThanOrEqual(1024)
			expect(readTraceEvents(join(tracesDir(), name)).length).toBeGreaterThan(0)
		}
		expect(resolveTraceFile(files[0] as string)).not.toBeNull()
	})

	it("bounds stalled writers and reports failed, unflushed work without holding capture", async () => {
		const recorder = createTraceRecorder({ append: () => new Promise<void>(() => {}), writeTimeoutMs: 5 })
		recorder?.emit({ type: "drain_start" })
		await expect(recorder?.flush?.()).resolves.toBeUndefined()
		await vi.waitFor(() => expect(recorder?.stats?.()?.failed).toBe(1))
		expect(recorder?.stats?.()).toMatchObject({ failed: 1, unflushed: 0, timedOut: 1, dropped: 0 })
	})

	it("serializes timed-out status when a later append succeeds", async () => {
		let attempts = 0
		const recorder = createTraceRecorder({
			writeTimeoutMs: 5,
			append: async (file, body) => {
				attempts++
				if (attempts === 1) return new Promise<void>(() => {})
				const { appendFile } = await import("node:fs/promises")
				await appendFile(file, body, "utf-8")
			},
		})
		recorder?.emit({ type: "drain_start" })
		await vi.waitFor(() => expect(recorder?.stats?.()?.failed).toBe(1))
		// The failed batch only surfaces stats when a later batch writes.
		await new Promise<void>((resolve) => setTimeout(resolve, 275))
		recorder?.emit({ type: "phase", phase: "store-add" })
		await vi.waitFor(
			() => expect(readTraceEvents(recorder?.file as string).some((event) => event.type === "trace_stats")).toBe(true),
			{
				timeout: 2_000,
			},
		)
		expect(recorder?.stats?.()).toMatchObject({ failed: 1, timedOut: 1 })
		const stat = readTraceEvents(recorder?.file as string).find((event) => event.type === "trace_stats")
		expect(stat).toMatchObject({ failed: 1, timedOut: 1, unflushed: 0 })
	})

	it("enforces an aggregate byte budget without parsing records", () => {
		mkdirSync(tracesDir(), { recursive: true })
		for (let i = 0; i < 3; i++)
			writeFileSync(join(tracesDir(), `drain-2026-11-${i}-test.jsonl`), "x".repeat(1024), "utf-8")
		pruneTraceBudget(2000)
		const remaining = readdirSync(tracesDir())
		expect(remaining.reduce((sum, name) => sum + statSync(join(tracesDir(), name)).size, 0)).toBeLessThanOrEqual(2000)
		expect(remaining.some((name) => name.includes("2-test"))).toBe(true)
	})

	it("reports dropped queue events explicitly", async () => {
		const recorder = createTraceRecorder({
			maxPending: 1,
			writeTimeoutMs: 5,
			append: () => new Promise<void>(() => {}),
		})
		recorder?.emit({ type: "phase", phase: "one" })
		recorder?.emit({ type: "phase", phase: "two" })
		expect(recorder?.stats?.()?.dropped).toBe(1)
		await recorder?.flush?.()
		await vi.waitFor(() => expect(recorder?.stats?.()?.failed).toBe(1))
		expect(recorder?.stats?.()).toMatchObject({ failed: 1, dropped: 1, unflushed: 0, timedOut: 1 })
	})

	it("returns null when KIMCHI_MEMORY_TRACE_DRAINS=0 (tracing off)", () => {
		process.env.KIMCHI_MEMORY_TRACE_DRAINS = "0"
		expect(createTraceRecorder()).toBeNull()
	})

	it("returns null and warns once per streak when the traces dir cannot be created", () => {
		// A regular file named "traces" blocks mkdir — the usage-ledger
		// unwritable-path technique.
		mkdirSync(join(home, ".config", "kimchi", "memory"), { recursive: true })
		writeFileSync(tracesDir(), "not a directory", "utf-8")
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(createTraceRecorder()).toBeNull()
			expect(createTraceRecorder()).toBeNull()
			expect(consoleWarn).toHaveBeenCalledTimes(1)
		} finally {
			consoleWarn.mockRestore()
		}
	})

	it("emit never throws when the drain file path becomes unwritable", async () => {
		const recorder = createTraceRecorder()
		expect(recorder).not.toBeNull()
		rmSync(recorder?.file as string, { force: true })
		mkdirSync(recorder?.file as string, { recursive: true })
		vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(() => recorder?.emit({ type: "phase" })).not.toThrow()
			expect(() => recorder?.emit({ type: "phase" })).not.toThrow()
			await expect(recorder?.flush?.()).resolves.toBeUndefined()
		} finally {
			vi.restoreAllMocks()
		}
	})
})

describe("pruneTraces", () => {
	it("keeps the newest `keep` drains by timestamped name, deletes the rest", () => {
		const names = [drainName("1"), drainName("2"), drainName("3"), drainName("4")]
		mkdirSync(tracesDir(), { recursive: true })
		for (const name of names) writeFileSync(join(tracesDir(), name), "{}\n", "utf-8")
		pruneTraces(2)
		expect(listTraceFiles()).toEqual([drainName("3"), drainName("4")])
	})

	it("leaves non-drain files alone and tolerates a missing dir", () => {
		expect(() => pruneTraces(2)).not.toThrow()
		mkdirSync(tracesDir(), { recursive: true })
		writeFileSync(join(tracesDir(), "other.txt"), "x", "utf-8")
		pruneTraces(0)
		expect(listTraceFiles()).toEqual([])
	})
})

describe("readTraceEvents", () => {
	it("drops an unparseable trailing line (crash tail / read-while-write)", () => {
		const file = join(tracesDir(), drainName("1"))
		mkdirSync(tracesDir(), { recursive: true })
		writeFileSync(
			file,
			`${JSON.stringify({ type: "drain_start" })}\n${JSON.stringify({ type: "job", job: "a.json" })}\n{"type":"ph`,
			"utf-8",
		)
		const events = readTraceEvents(file)
		expect(events).toHaveLength(2)
		expect(events[0]?.type).toBe("drain_start")
		expect(events[1]?.type).toBe("job")
	})

	it("skips a corrupt middle line instead of losing the whole drain", () => {
		const file = join(tracesDir(), drainName("2"))
		mkdirSync(tracesDir(), { recursive: true })
		writeFileSync(file, `${JSON.stringify({ type: "a" })}\nnot json\n${JSON.stringify({ type: "b" })}\n`, "utf-8")
		expect(readTraceEvents(file).map((e) => e.type)).toEqual(["a", "b"])
	})
})

describe("resolveTraceFile", () => {
	it("resolves a real drain file inside traces/", () => {
		const name = drainName("9")
		mkdirSync(tracesDir(), { recursive: true })
		const file = join(tracesDir(), name)
		writeFileSync(file, "{}\n", "utf-8")
		expect(resolveTraceFile(name)).toBe(file)
	})

	it("rejects traversal, nested paths, non-drain names, and missing files", () => {
		mkdirSync(tracesDir(), { recursive: true })
		writeFileSync(join(tracesDir(), drainName("9")), "{}\n", "utf-8")
		expect(resolveTraceFile(`../${drainName("9")}`)).toBeNull()
		expect(resolveTraceFile(`sub/${drainName("9")}`)).toBeNull()
		expect(resolveTraceFile("drain-9.json")).toBeNull()
		expect(resolveTraceFile(`${drainName("0")}`)).toBeNull() // missing file
		expect(resolveTraceFile("")).toBeNull()
	})
})

describe("traceRecallKeep", () => {
	it("defaults to TRACE_RECALLS_KEPT when the env var is unset", () => {
		delete process.env.KIMCHI_MEMORY_TRACE_RECALLS
		expect(traceRecallKeep()).toBe(TRACE_RECALLS_KEPT)
	})

	it("honors KIMCHI_MEMORY_TRACE_RECALLS, including 0 = off", () => {
		process.env.KIMCHI_MEMORY_TRACE_RECALLS = "5"
		expect(traceRecallKeep()).toBe(5)
		process.env.KIMCHI_MEMORY_TRACE_RECALLS = "0"
		expect(traceRecallKeep()).toBe(0)
	})
})

describe("createRecallRecorder", () => {
	it("writes recall-*.jsonl files with ts-stamped events", async () => {
		const recorder = createRecallRecorder()
		expect(recorder).not.toBeNull()
		expect(recorder?.file).toContain(`${tracesDir()}/recall-`)
		recorder?.emit({ type: "recall", kind: "tool-search", query: "q", hits: [] })
		await recorder?.flush?.()
		const events = readTraceEvents(recorder?.file as string)
		expect(events[0]?.type).toBe("recall")
		expect(events[0]?.kind).toBe("tool-search")
	})

	it("disambiguates concurrent recalls in the same millisecond", () => {
		const a = createRecallRecorder()
		const b = createRecallRecorder()
		expect(a?.file).not.toBe(b?.file)
	})

	it("returns null when KIMCHI_MEMORY_TRACE_RECALLS=0", () => {
		process.env.KIMCHI_MEMORY_TRACE_RECALLS = "0"
		expect(createRecallRecorder()).toBeNull()
	})

	it("prunes the recall ring, never the drain files", () => {
		mkdirSync(tracesDir(), { recursive: true })
		writeFileSync(join(tracesDir(), drainName("7")), "{}\n")
		for (let i = 0; i < 5; i++) writeFileSync(join(tracesDir(), `recall-2026-11-12T09-41-0${i}-1-${i}.jsonl`), "{}\n")
		pruneRecallTraces(2)
		expect(listRecallFiles()).toHaveLength(2)
		expect(listTraceFiles()).toEqual([drainName("7")])
	})
})

describe("listRecallFiles + resolveRecallFile", () => {
	it("lists recall files and resolves real ones, rejecting drains and traversal", () => {
		mkdirSync(tracesDir(), { recursive: true })
		const recall = "recall-2026-11-12T09-41-01-1234-0.jsonl"
		writeFileSync(join(tracesDir(), recall), "{}\n")
		writeFileSync(join(tracesDir(), drainName("6")), "{}\n")
		expect(listRecallFiles()).toEqual([recall])
		expect(resolveRecallFile(recall)).toBe(join(tracesDir(), recall))
		expect(resolveRecallFile(`../${recall}`)).toBeNull()
		expect(resolveRecallFile(drainName("6"))).toBeNull()
		expect(resolveRecallFile("recall-missing.jsonl")).toBeNull()
		expect(resolveRecallFile("")).toBeNull()
	})
})
