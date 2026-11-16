import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	armBlockingInstructions,
	instrumentBlockingInstructions,
	openInstructionCounter,
	summarizeBlockingInstructions,
} from "./blocking-instructions.js"

interface Mark {
	event: string
	[key: string]: unknown
}
const marks = (path: string): Mark[] =>
	readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Mark)

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "blocking-instructions-"))
})
afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe("blocking instruction trace", () => {
	it("records the fake counter's deltas and closes once with a complete summary", () => {
		const path = join(dir, "passes.jsonl")
		let readings = 0
		let closes = 0
		let now = 0
		let tick: (() => void) | undefined
		const handle = instrumentBlockingInstructions(
			path,
			() => ({
				counter: {
					read: () => readings++ * 17 + 10,
					close: () => closes++,
				},
			}),
			{
				now: () => now,
				schedule(callback) {
					tick = callback
					return { cancel: () => {} }
				},
			},
		)
		// 51, 69 and 100 ms imply watchdog lags of 41, 59 and 90 ms.
		// Supplying the clock avoids machine-speed-dependent timer coalescing.
		for (const time of [51, 120, 220]) {
			now = time
			tick?.()
		}
		handle.close()
		handle.close()
		expect(readFileSync(path, { encoding: "utf8" }).length).toBeGreaterThan(0)
		const records = marks(path)
		const summary = records.find((mark) => mark.event === "blocking.instr.summary")
		if (!summary) throw new Error("missing instruction summary")
		expect(summary).toMatchObject({ truncated: false })
		expect(summary?.samples).toBeGreaterThan(0)
		expect(summary?.max).toBe(17)
		expect(summary?.total).toBe((summary.samples as number) * 17)
		expect(summary?.p95).toBe(17)
		expect(summary?.p95).toEqual(expect.any(Number))
		expect(closes).toBe(1)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(records.every((mark) => mark.pid === process.pid)).toBe(true)
	})

	it("bounds summarization without sorting or mutating the input", () => {
		const input = [400, 1_000, 200, 100]
		expect(summarizeBlockingInstructions(input)).toEqual({
			samples: 4,
			total: 1_700,
			max: 1_000,
			p95: 1_000,
			truncated: false,
		})
		expect(input).toEqual([400, 1_000, 200, 100])
		expect(summarizeBlockingInstructions([])).toEqual({ samples: 0, total: 0, max: 0, p95: 0, truncated: false })
	})

	it("reports unsupported hosts rather than inventing measurements", () => {
		const path = join(dir, "unsupported.jsonl")
		if (process.platform !== "linux") {
			const result = openInstructionCounter()
			expect(result.counter).toBeUndefined()
			expect(result.reason).toMatch("unsupported platform")
		}
		instrumentBlockingInstructions(path, () => ({ reason: "perf_event_open: unavailable" }))
		const records = marks(path)
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({ event: "blocking.instr.unsupported", reason: "perf_event_open: unavailable" })
	})

	it("shares one counter between repeated registrations and closes by identity", () => {
		// This test uses the real production sharing code, backed by its normal
		// non-Linux/Node deprecation result. It cannot open a second PMU by accident.
		const path = join(dir, "shared.jsonl")
		const first = armBlockingInstructions(path)
		const second = armBlockingInstructions(path)
		second.close()
		expect(marks(path).length).toBeGreaterThan(0)
		first.close()
		first.close()
		expect(marks(path)).toHaveLength(1) // unsupported entry, one only
	})

	it("does not crash when the diagnostic sink itself cannot be written", () => {
		const original = console.error
		const warnings: string[] = []
		console.error = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
		try {
			expect(() => instrumentBlockingInstructions(dir, () => ({ reason: "no backend" }))).not.toThrow()
			expect(warnings.some((line) => line.includes("cannot write trace"))).toBe(true)
		} finally {
			console.error = original
		}
	})

	it("fails visibly without crashing when the first counter read fails", () => {
		const path = join(dir, "counter-error.jsonl")
		const handle = instrumentBlockingInstructions(path, () => ({
			counter: {
				read: () => {
					throw new Error("perf read denied")
				},
				close: () => {},
			},
		}))
		handle.close()
		expect(marks(path).some((mark) => mark.event === "blocking.instr.error")).toBe(true)
	})
})
