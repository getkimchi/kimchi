import { afterEach, describe, expect, it, vi } from "vitest"
import { watchQueuedUserInput } from "./queued-input-watch.js"

afterEach(() => {
	vi.useRealTimers()
})

describe("watchQueuedUserInput", () => {
	it("probes synchronously once and leaves no timer when input is already queued", () => {
		vi.useFakeTimers()
		const pending = vi.fn(() => true)
		const queued = vi.fn()
		const stop = watchQueuedUserInput(pending, queued, { pollIntervalMs: 100 })

		expect(pending).toHaveBeenCalledTimes(1)
		expect(queued).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		stop()
	})

	it("uses the supplied cadence and stops polling before notification", () => {
		vi.useFakeTimers()
		let pendingInput = false
		const queued = vi.fn()
		watchQueuedUserInput(() => pendingInput, queued, { pollIntervalMs: 100 })
		vi.advanceTimersByTime(100)
		expect(queued).not.toHaveBeenCalled()

		pendingInput = true
		vi.advanceTimersByTime(100)
		expect(queued).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("defers initial probing and starts the interval only after a negative probe", () => {
		vi.useFakeTimers()
		let pendingInput = true
		const queued = vi.fn()
		watchQueuedUserInput(() => pendingInput, queued, { pollIntervalMs: 50, initialDelayMs: 500 })
		vi.advanceTimersByTime(499)
		expect(queued).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(queued).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)

		pendingInput = false
		const second = vi.fn()
		const stop = watchQueuedUserInput(() => pendingInput, second, { pollIntervalMs: 50, initialDelayMs: 500 })
		vi.advanceTimersByTime(500)
		expect(second).not.toHaveBeenCalled()
		pendingInput = true
		vi.advanceTimersByTime(50)
		expect(second).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
		stop()
	})

	it("cancels the delayed probe and active interval independently", () => {
		vi.useFakeTimers()
		const pending = vi.fn(() => false)
		watchQueuedUserInput(pending, vi.fn(), { pollIntervalMs: 50, initialDelayMs: 500 })()
		expect(vi.getTimerCount()).toBe(0)
		vi.advanceTimersByTime(1000)
		expect(pending).not.toHaveBeenCalled()

		const stop = watchQueuedUserInput(pending, vi.fn(), { pollIntervalMs: 50 })
		expect(vi.getTimerCount()).toBe(1)
		stop()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("contains probe errors only when the caller opts into that policy", () => {
		vi.useFakeTimers()
		const failure = new Error("stale session")
		const pending = () => {
			throw failure
		}
		const queued = vi.fn()
		watchQueuedUserInput(pending, queued, { pollIntervalMs: 100, suppressProbeErrors: true })
		expect(queued).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(1)
		vi.clearAllTimers()

		expect(() => watchQueuedUserInput(pending, queued, { pollIntervalMs: 100 })).toThrow(failure)
		expect(vi.getTimerCount()).toBe(0)
	})
})
