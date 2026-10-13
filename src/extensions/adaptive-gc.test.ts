import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAdaptiveGcScheduler, idleGcEnabled, resetAdaptiveGcForTests } from "./adaptive-gc.js"

describe("adaptive-gc", () => {
	beforeEach(() => {
		delete process.env.KIMCHI_IDLE_GC
		delete process.env.KIMCHI_IDLE_GC_DELAY_MS
		delete process.env.KIMCHI_GC_GROWTH_BYTES
		delete process.env.KIMCHI_GC_MIN_INTERVAL_MS
		resetAdaptiveGcForTests()
	})
	afterEach(() => {
		vi.useRealTimers()
		delete process.env.KIMCHI_IDLE_GC
		delete process.env.KIMCHI_IDLE_GC_DELAY_MS
		delete process.env.KIMCHI_GC_GROWTH_BYTES
		delete process.env.KIMCHI_GC_MIN_INTERVAL_MS
	})

	describe("idle path", () => {
		it("collects after the idle delay", () => {
			vi.useFakeTimers()
			const gather = vi.fn()
			const scheduler = createAdaptiveGcScheduler(gather, { idleDelayMs: 5_000, rssOf: () => 100 })
			scheduler.onAgentEnd()
			expect(gather).not.toHaveBeenCalled()
			vi.advanceTimersByTime(4_999)
			expect(gather).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1)
			expect(gather).toHaveBeenCalledTimes(1)
		})

		it("agent_start cancels the pending collection", () => {
			vi.useFakeTimers()
			const gather = vi.fn()
			const scheduler = createAdaptiveGcScheduler(gather, { idleDelayMs: 5_000, rssOf: () => 100 })
			scheduler.onAgentEnd()
			scheduler.onAgentStart()
			vi.advanceTimersByTime(60_000)
			expect(gather).not.toHaveBeenCalled()
		})

		it("re-arms after each agent_end", () => {
			vi.useFakeTimers()
			const gather = vi.fn()
			const scheduler = createAdaptiveGcScheduler(gather, { idleDelayMs: 5_000, rssOf: () => 100 })
			scheduler.onAgentEnd()
			vi.advanceTimersByTime(5_000)
			scheduler.onAgentEnd()
			vi.advanceTimersByTime(5_000)
			expect(gather).toHaveBeenCalledTimes(2)
		})

		it("collects immediately when the idle delay is zero", () => {
			const gather = vi.fn()
			const scheduler = createAdaptiveGcScheduler(gather, { idleDelayMs: 0, rssOf: () => 100 })
			scheduler.onAgentEnd()
			expect(gather).toHaveBeenCalledTimes(1)
		})

		it("unrefs the idle timer so it never holds the event loop open", () => {
			// Stub setTimeout (no fake timers — we need to observe the real
			// unref() call on the object the scheduler receives).
			const realSetTimeout = globalThis.setTimeout
			let unrefCalls = 0
			let armed: unknown
			const stub = ((handler: TimerHandler, timeout?: number) => {
				armed = realSetTimeout(handler, timeout ?? 0)
				return {
					unref: () => {
						unrefCalls += 1
					},
				}
			}) as unknown as typeof setTimeout
			const globalScope = globalThis as { setTimeout: typeof setTimeout }
			const saved = globalScope.setTimeout
			globalScope.setTimeout = stub
			try {
				const gather = vi.fn()
				createAdaptiveGcScheduler(gather, { idleDelayMs: 5_000, rssOf: () => 100 }).onAgentEnd()
				expect(unrefCalls).toBe(1)
			} finally {
				globalScope.setTimeout = saved
				if (armed !== undefined) clearTimeout(armed as Parameters<typeof clearTimeout>[0])
			}
		})

		it("defers the idle collection while another session is active, then collects once alone", () => {
			vi.useFakeTimers()
			const gather = vi.fn()
			let othersActive = true
			const scheduler = createAdaptiveGcScheduler(gather, {
				idleDelayMs: 5_000,
				rssOf: () => 100,
				othersActive: () => othersActive,
			})
			scheduler.onAgentEnd()
			vi.advanceTimersByTime(5_000) // fires into a busy window: re-arms, no collection
			expect(gather).not.toHaveBeenCalled()
			othersActive = false
			vi.advanceTimersByTime(5_000) // next window: alone → collects
			expect(gather).toHaveBeenCalledTimes(1)
		})
	})

	describe("growth path (long uninterrupted runs)", () => {
		it("collects when RSS growth crosses the threshold at a message boundary", () => {
			const gather = vi.fn()
			let rss = 100 * 1024 * 1024
			const scheduler = createAdaptiveGcScheduler(gather, {
				growthBytes: 50 * 1024 * 1024,
				minIntervalMs: 0,
				rssOf: () => rss,
			})
			scheduler.onMessageEnd() // at baseline: no collection
			expect(gather).not.toHaveBeenCalled()
			rss += 40 * 1024 * 1024
			scheduler.onMessageEnd() // below threshold
			expect(gather).not.toHaveBeenCalled()
			rss += 20 * 1024 * 1024
			scheduler.onMessageEnd() // +60 MiB: crosses
			expect(gather).toHaveBeenCalledTimes(1)
		})

		it("re-baselines to the post-GC RSS so growth measures garbage, not live content", () => {
			let rss = 100
			let collections = 0
			// A real Bun.gc(true) reclaims synchronously: the live set (100) stays,
			// the garbage above it goes. gather models that by dropping rss to 100.
			const gather = () => {
				collections++
				rss = 100
			}
			const scheduler = createAdaptiveGcScheduler(gather, {
				growthBytes: 50,
				minIntervalMs: 0,
				rssOf: () => rss,
			})
			rss = 160 // 60 of garbage above the 100 live set
			scheduler.onMessageEnd()
			expect(collections).toBe(1) // collected; baseline is now 100
			rss = 140 // 40 of NEW garbage: below threshold
			scheduler.onMessageEnd()
			expect(collections).toBe(1)
			rss = 170 // 70 of garbage: crosses again
			scheduler.onMessageEnd()
			expect(collections).toBe(2)
		})

		it("throttles growth collections to the minimum interval", () => {
			vi.useFakeTimers()
			vi.setSystemTime(1_000_000)
			const gather = vi.fn()
			let rss = 100
			const scheduler = createAdaptiveGcScheduler(gather, {
				growthBytes: 50,
				minIntervalMs: 30_000,
				rssOf: () => rss,
			})
			rss = 200
			scheduler.onMessageEnd() // fires (first)
			expect(gather).toHaveBeenCalledTimes(1)
			rss = 400
			vi.advanceTimersByTime(10_000)
			scheduler.onMessageEnd() // throttled
			expect(gather).toHaveBeenCalledTimes(1)
			vi.advanceTimersByTime(25_000)
			scheduler.onMessageEnd() // 35s later: fires
			expect(gather).toHaveBeenCalledTimes(2)
		})

		it("gates growth collections while another session has a request in flight", () => {
			const gather = vi.fn()
			let rss = 100
			let othersActive = true
			const scheduler = createAdaptiveGcScheduler(gather, {
				growthBytes: 50,
				minIntervalMs: 0,
				rssOf: () => rss,
				othersActive: () => othersActive,
			})
			rss = 200 // crosses the threshold
			scheduler.onMessageEnd() // another session mid-request: deferred
			expect(gather).not.toHaveBeenCalled()
			othersActive = false
			scheduler.onMessageEnd() // alone now: collects
			expect(gather).toHaveBeenCalledTimes(1)
		})

		it("two real schedulers gate each other through the module registry", () => {
			const gatherA = vi.fn()
			const gatherB = vi.fn()
			let rss = 100
			const a = createAdaptiveGcScheduler(gatherA, { growthBytes: 50, minIntervalMs: 0, rssOf: () => rss })
			const b = createAdaptiveGcScheduler(gatherB, { growthBytes: 50, minIntervalMs: 0, rssOf: () => rss })
			a.onAgentStart()
			b.onAgentStart() // both sessions mid-turn → registry size 2
			rss = 200 // crosses the threshold
			a.onMessageEnd() // A is between messages, but B is mid-request: gated
			expect(gatherA).not.toHaveBeenCalled()
			b.onAgentEnd() // B goes idle → registry size 1
			a.onMessageEnd() // now A is the only active agent: collects
			expect(gatherA).toHaveBeenCalledTimes(1)
			a.onAgentEnd() // cleanup
		})

		it("a collection error is surfaced, not swallowed", () => {
			vi.useFakeTimers()
			const error = vi.spyOn(console, "error").mockImplementation(() => {})
			const gather = () => {
				throw new Error("gc boom")
			}
			const scheduler = createAdaptiveGcScheduler(gather, { idleDelayMs: 100, rssOf: () => 100 })
			scheduler.onAgentEnd()
			vi.advanceTimersByTime(100)
			expect(error).toHaveBeenCalledWith("[adaptive-gc] collection failed:", expect.any(Error))
			error.mockRestore()
		})
	})

	it("KIMCHI_IDLE_GC=off disables the extension", () => {
		process.env.KIMCHI_IDLE_GC = "off"
		expect(idleGcEnabled()).toBe(false)
	})
})
