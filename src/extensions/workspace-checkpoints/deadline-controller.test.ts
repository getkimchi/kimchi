import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DeadlineController, finalizationDelayMs, parseMaxSessionDuration } from "./deadline-controller.js"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("session duration parsing", () => {
	it("leaves an absent deadline unset", () => {
		expect(parseMaxSessionDuration(undefined)).toBeUndefined()
	})

	it("parses positive integers", () => {
		expect(parseMaxSessionDuration("60")).toBe(60)
		expect(parseMaxSessionDuration(" 900 ")).toBe(900)
	})

	it("rejects invalid values loudly", () => {
		for (const value of ["0", "-1", "1.5", "soon", "NaN"]) {
			expect(() => parseMaxSessionDuration(value)).toThrow("expected a positive integer")
		}
	})
})

describe("DeadlineController", () => {
	it("uses ten percent with a five-minute cap for finalization", () => {
		expect(finalizationDelayMs(60)).toBe(54_000)
		expect(finalizationDelayMs(3600)).toBe(3300_000)
	})

	it("emits finalization once and cancels the hard deadline on disposal", () => {
		const finalize = vi.fn()
		const abort = vi.fn()
		const controller = new DeadlineController(60, { finalize, abort })
		controller.start()
		vi.advanceTimersByTime(54_000)
		expect(finalize).toHaveBeenCalledTimes(1)
		controller.dispose()
		vi.advanceTimersByTime(60_000)
		expect(abort).not.toHaveBeenCalled()
	})

	it("aborts at the actual hard deadline when still running", () => {
		const abort = vi.fn()
		new DeadlineController(60, { finalize: vi.fn(), abort }).start()
		vi.advanceTimersByTime(60_000)
		expect(abort).toHaveBeenCalledTimes(1)
	})

	it("reschedules long durations instead of firing at Node's timer limit", () => {
		const finalize = vi.fn()
		const abort = vi.fn()
		const controller = new DeadlineController(2_148_083.647, { finalize, abort })
		controller.start()
		vi.advanceTimersByTime(2_147_483_647)
		expect(finalize).not.toHaveBeenCalled()
		expect(abort).not.toHaveBeenCalled()
		vi.advanceTimersByTime(300_000)
		expect(finalize).toHaveBeenCalledTimes(1)
		expect(abort).not.toHaveBeenCalled()
		vi.advanceTimersByTime(300_000)
		expect(abort).toHaveBeenCalledTimes(1)
		controller.dispose()
	})

	it("does not arm twice for the same controller", () => {
		const finalize = vi.fn()
		const controller = new DeadlineController(60, { finalize, abort: vi.fn() })
		controller.start()
		controller.start()
		vi.advanceTimersByTime(54_000)
		expect(finalize).toHaveBeenCalledTimes(1)
		controller.dispose()
	})
})
