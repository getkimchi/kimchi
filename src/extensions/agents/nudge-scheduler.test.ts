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
	})
})
