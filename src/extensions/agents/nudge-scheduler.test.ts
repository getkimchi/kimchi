import { afterEach, describe, expect, it, vi } from "vitest"
import { NudgeScheduler } from "./nudge-scheduler.js"

afterEach(() => {
	vi.useRealTimers()
})

describe("NudgeScheduler", () => {
	it("fires the callback after the hold delay", () => {
		vi.useFakeTimers()
		const scheduler = new NudgeScheduler(200)
		const cb = vi.fn()

		scheduler.schedule("agent-1", cb)
		expect(cb).not.toHaveBeenCalled()

		vi.advanceTimersByTime(199)
		expect(cb).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(cb).toHaveBeenCalledTimes(1)
	})

	it("coalesces by key — scheduling a new nudge cancels the previous one for the same key", () => {
		vi.useFakeTimers()
		const scheduler = new NudgeScheduler(200)
		const first = vi.fn()
		const second = vi.fn()

		scheduler.schedule("agent-1", first)
		scheduler.schedule("agent-1", second)

		vi.advanceTimersByTime(300)
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
	})

	it("supports multiple independent keys", () => {
		vi.useFakeTimers()
		const scheduler = new NudgeScheduler(100)
		const cb1 = vi.fn()
		const cb2 = vi.fn()

		scheduler.schedule("a", cb1)
		scheduler.schedule("b", cb2)

		vi.advanceTimersByTime(150)
		expect(cb1).toHaveBeenCalledTimes(1)
		expect(cb2).toHaveBeenCalledTimes(1)
	})

	it("cancel prevents the callback from firing", () => {
		vi.useFakeTimers()
		const scheduler = new NudgeScheduler(200)
		const cb = vi.fn()

		scheduler.schedule("agent-1", cb)
		scheduler.cancel("agent-1")

		vi.advanceTimersByTime(300)
		expect(cb).not.toHaveBeenCalled()
		expect(scheduler.hasPending("agent-1")).toBe(false)
	})

	// ---- Shutdown guard (the core fix) ----

	describe("beginShutdown", () => {
		it("clears all pending nudges", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(200)
			const cb1 = vi.fn()
			const cb2 = vi.fn()

			scheduler.schedule("a", cb1)
			scheduler.schedule("b", cb2)
			expect(scheduler.pendingCount).toBe(2)

			scheduler.beginShutdown()

			expect(scheduler.pendingCount).toBe(0)
			expect(scheduler.isShuttingDown).toBe(true)

			vi.advanceTimersByTime(500)
			expect(cb1).not.toHaveBeenCalled()
			expect(cb2).not.toHaveBeenCalled()
		})

		it("prevents new nudges from being scheduled after shutdown", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(200)
			const cb = vi.fn()

			scheduler.beginShutdown()
			scheduler.schedule("agent-1", cb)

			expect(scheduler.hasPending("agent-1")).toBe(false)
			vi.advanceTimersByTime(500)
			expect(cb).not.toHaveBeenCalled()
		})

		it("schedules and fires normally when not shutting down", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(100)
			const cb = vi.fn()

			scheduler.schedule("agent-1", cb)
			vi.advanceTimersByTime(100)
			expect(cb).toHaveBeenCalledTimes(1)
		})
	})

	// ---- Regression: agents completing during waitForSubagentShutdown ----

	describe("regression: race during session_shutdown", () => {
		it("does not crash when agents complete during shutdown and try to schedule nudges", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(200)
			const staleCb = vi.fn(() => {
				// This callback would call pi.sendMessage with a stale ctx
				// but with the shutdown guard, it should never be scheduled
				throw new Error("This extension ctx is stale after session replacement or reload.")
			})

			// Simulate session_shutdown: abortAll → beginShutdown → waitForSubagentShutdown
			scheduler.beginShutdown()

			// During waitForSubagentShutdown, agents complete and try to schedule nudges
			scheduler.schedule("completing-agent", staleCb)

			// The nudge timer should never fire because scheduling was blocked
			vi.advanceTimersByTime(500)
			expect(staleCb).not.toHaveBeenCalled()
		})

		it("allows nudges scheduled before shutdown to be cleared by beginShutdown", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(200)
			const earlyCb = vi.fn(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.")
			})

			// Agent completes before shutdown, schedules a nudge
			scheduler.schedule("early-agent", earlyCb)

			// session_shutdown fires immediately after, clearing pending nudges
			scheduler.beginShutdown()

			// The early nudge should have been cleared, not fired
			vi.advanceTimersByTime(500)
			expect(earlyCb).not.toHaveBeenCalled()
		})

		it("blocks group nudge when batchFinalizeTimer fires after shutdown begins", () => {
			vi.useFakeTimers()
			const scheduler = new NudgeScheduler(200)
			const groupCb = vi.fn(() => {
				throw new Error("This extension ctx is stale after session replacement or reload.")
			})

			// Simulate session_shutdown clearing the batch finalize timer
			// and arming the nudge scheduler shutdown guard
			scheduler.beginShutdown()

			// Simulate batchFinalizeTimer firing during waitForSubagentShutdown:
			// finalizeBatch() calls scheduleNudge(groupKey, cb), which delegates
			// to nudgeScheduler.schedule(). This must be a no-op.
			scheduler.schedule("group:agent-1,agent-2", groupCb)

			vi.advanceTimersByTime(500)
			expect(groupCb).not.toHaveBeenCalled()
			expect(scheduler.hasPending("group:agent-1,agent-2")).toBe(false)
		})
	})
})
