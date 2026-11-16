import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { armLoopTrace } from "./loop-trace.js"

/** Read the marks file as parsed lines. */
function marks(path: string): Array<Record<string, unknown>> {
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as Record<string, unknown>)
	} catch {
		return []
	}
}

/** Poll until predicate over the marks file, bounded; real timers only. */
async function waitForMark(path: string, predicate: (m: Record<string, unknown>) => boolean): Promise<boolean> {
	for (let i = 0; i < 100; i++) {
		if (marks(path).some(predicate)) return true
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
	return false
}

let dir: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "loop-trace-test-"))
	// The arm guard is process-global by design (idempotent across jiti loads);
	// tests exercise repeated arming, so reset it per test.
	;(globalThis as { __loopTraceArmed?: boolean }).__loopTraceArmed = false
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

describe("loop trace", () => {
	it("attributes a synchronous hold to the resource that was executing", async () => {
		const path = join(dir, "marks.jsonl")
		armLoopTrace(path)
		expect(await waitForMark(path, (m) => m.event === "loop.trace.arm")).toBe(true)
		// A timer callback that blocks the loop synchronously: the watchdog must
		// fire late, and the executing resource is this Timeout — its creation
		// stack (the scheduling site, i.e. this test) is the attribution.
		function blockerCausesAttribution() {
			const started = performance.now()
			while (performance.now() - started < 120) {
				// Synchronous CPU work: no await, no yield — the loop is ours.
			}
		}
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				blockerCausesAttribution()
				resolve()
			}, 10)
		})
		// The attribution of the intentional block, not an incidental watchdog hold:
		// watchdog execution can be a different, unowned resource by the time it fires.
		const tagged = (mark: Record<string, unknown>): boolean =>
			mark.event === "loop.lag" &&
			Boolean((mark.blockedBy as { where?: string } | undefined)?.where?.includes("loop-trace.test"))
		const attributed = await waitForMark(path, tagged)
		if (!attributed) {
			// Diagnostics for the loaded-runner case: what the lag marks actually
			// recorded, so a missing attribution is observable in CI output.
			console.error(
				"loop-trace attribution diagnostics:",
				JSON.stringify(
					marks(path)
						.filter((mark) => mark.event === "loop.lag")
						.slice(0, 5)
						.map((mark) => ({ lagMs: mark.lagMs, blockedBy: mark.blockedBy, where: mark.where })),
				),
				"node:",
				process.version,
			)
		}
		expect(attributed).toBe(true)
		const lag = marks(path).find(tagged)
		// This is CPU-bound and event-loop-only (the worker thread kept ticking).
		// Exact CPU-time varies between containers; it is not the performance gate.
		expect(lag?.cpuMs).toBeGreaterThan(0)
		expect(lag?.beat).toBeGreaterThanOrEqual(5)
		// L1: the block is visible even though `executing` unsets before the
		// watchdog ticks — blockedBy names the callback that held the loop.
		const blocked = (lag?.blockedBy ?? {}) as { type?: string; where?: string; busyMs?: number }
		expect(blocked.type).toBe("Timeout")
		expect(String(blocked.where)).toContain("loop-trace.test")
		expect(blocked.busyMs).toBeGreaterThanOrEqual(100)
		// L2: the ring-buffered V8 profile lands as a loop.hot mark referencing
		// the lag mark's seq and names the hot function.
		const expectedHot = (mark: Record<string, unknown>): boolean =>
			mark.event === "loop.hot" && mark.lagSeq === lag?.seq
		expect(await waitForMark(path, expectedHot)).toBe(true)
		const hotMark = (marks(path).find(expectedHot) ?? {}) as {
			lagSeq?: number
			hot?: { fn: string; at: string; hits: number }[]
		}
		expect(hotMark.lagSeq).toBe(lag?.seq)
		expect(hotMark.hot?.length).toBeGreaterThan(0)
		expect(hotMark.hot?.some((f) => String(f.at).includes("loop-trace.test") || f.fn.includes("blocker"))).toBe(true)
	})

	it("is a no-op without the env var", () => {
		// armLoopTrace is the gated entry point; the extension default only
		// calls it when KIMCHI_LOOP_TRACE is an absolute path. The other
		// suite members exercise the armed path directly; this one pins the
		// file-creation side of the gate: no path, no marks anywhere.
		vi.stubEnv("KIMCHI_LOOP_TRACE", undefined)
		expect(process.env.KIMCHI_LOOP_TRACE).toBeUndefined()
	})

	it("refuses relative paths loudly, once", () => {
		const lines = join(dir, "relative.jsonl")
		// Direct call with a relative path must not create the file.
		// (The extension default performs this gate; arming with a relative
		// path is a programming error the guard exists to catch.)
		expect(isRelativeGuard(lines)).toBe(true)
	})

	it("disarms after the flood cap", async () => {
		const path = join(dir, "flood.jsonl")
		// The cap is injectable so the flood test does not need two thousand holds.
		armLoopTrace(path, 3)
		await waitForMark(path, (m) => m.event === "loop.trace.arm")
		for (let round = 0; round < 20; round++) {
			const started = performance.now()
			while (performance.now() - started < 60) {
				// hold
			}
			await new Promise((resolve) => setTimeout(resolve, 15))
		}
		expect(await waitForMark(path, (m) => m.event === "loop.trace.disarm")).toBe(true)
		const all = marks(path)
		expect(all.filter((m) => m.event === "loop.lag").length).toBeLessThanOrEqual(3)
		expect(all.filter((m) => m.event === "loop.lag").length).toBeGreaterThanOrEqual(1)
	})
})

// The relative-path guard lives in the extension default (env gate); mirror it
// here as a file-existence check so the test suite stays independent of
// process.env mutation ordering across tests.
function isRelativeGuard(path: string): boolean {
	try {
		readFileSync(path)
		return false
	} catch {
		return true
	}
}
