import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TRACE_DRAINS_KEPT } from "./config.js"
import {
	createTraceRecorder,
	listTraceFiles,
	pruneTraces,
	readTraceEvents,
	resolveTraceFile,
	traceDrainKeep,
	tracesDir,
} from "./trace.js"

// Trace paths resolve from HOME (via defaultMemoryDir) — an isolated temp
// home keeps the suite off the developer's real traces.
const realHome = process.env.HOME
const realTrimEnv = process.env.KIMCHI_MEMORY_TRACE_DRAINS
let home: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kimchi-memory-trace-"))
	process.env.HOME = home
	delete process.env.KIMCHI_MEMORY_TRACE_DRAINS
})

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME
	else process.env.HOME = realHome
	if (realTrimEnv === undefined) delete process.env.KIMCHI_MEMORY_TRACE_DRAINS
	else process.env.KIMCHI_MEMORY_TRACE_DRAINS = realTrimEnv
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
	it("appends newline-terminated JSON events, ts stamped at emit", () => {
		const recorder = createTraceRecorder()
		expect(recorder).not.toBeNull()
		expect(recorder?.file).toContain(`${tracesDir()}${"/drain-"}`)
		expect(recorder?.file.endsWith(".jsonl")).toBe(true)
		recorder?.emit({ type: "drain_start", pid: 1 })
		recorder?.emit({ type: "phase", phase: "store-add", fact: "hello" })
		const events = readTraceEvents(recorder?.file as string)
		expect(events.map((e) => e.type)).toEqual(["drain_start", "phase"])
		for (const event of events) {
			expect(typeof event.ts === "string" && !Number.isNaN(Date.parse(event.ts))).toBe(true)
		}
		expect(events[1]?.phase).toBe("store-add")
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

	it("emit never throws when the drain file path becomes unwritable", () => {
		const recorder = createTraceRecorder()
		expect(recorder).not.toBeNull()
		// Replace the file with a directory → appendFileSync fails on every emit.
		rmSync(recorder?.file as string, { force: true })
		mkdirSync(recorder?.file as string, { recursive: true })
		vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			expect(() => recorder?.emit({ type: "phase" })).not.toThrow()
			expect(() => recorder?.emit({ type: "phase" })).not.toThrow()
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
