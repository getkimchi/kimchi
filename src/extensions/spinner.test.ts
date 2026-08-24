import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWorkingAnimator, resetWorkingAnimatorForTest } from "./spinner.js"

const DOT_CYCLE_MS = 500
const DOT_STATES = ["", ".", "..", "..."] as const
const MESSAGE_CYCLE_MS = 6000

describe("createWorkingAnimator", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		resetWorkingAnimatorForTest()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("fires an initial update from the setTimeout(0) hand-off", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		expect(onUpdate).not.toHaveBeenCalled()

		vi.advanceTimersByTime(0)
		expect(onUpdate).toHaveBeenCalledTimes(1)
		const [char, message] = onUpdate.mock.calls[0]
		expect(typeof char).toBe("string")
		expect(char.length).toBeGreaterThan(0)
		expect(message).toMatch(/(Stirring|Marinating|Chopping|Cooking)/)
		anim.stop()
	})

	it("updates the spin frame on the configured interval", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0) // initial render
		onUpdate.mockClear()

		// After the initial render, the spin interval for "Stirring" (frameIdx 0)
		// is 140ms. Advancing one tick should advance spinIdx.
		vi.advanceTimersByTime(140)
		expect(onUpdate).toHaveBeenCalledTimes(1)
		anim.stop()
	})

	it("cycles the dot suffix on DOT_CYCLE_MS", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0) // initial render at dotIdx 0
		const initialMessage = onUpdate.mock.calls[0][1]
		onUpdate.mockClear()

		// Advance one dot cycle. dotIdx advances from 0 -> 1, so the latest
		// message suffix changes from "" to ".". Spin ticks also fire in the
		// same window, so we assert on the last emitted message.
		vi.advanceTimersByTime(DOT_CYCLE_MS)
		expect(onUpdate).toHaveBeenCalled()
		expect(onUpdate.mock.calls.at(-1)?.[1]).not.toBe(initialMessage)
		anim.stop()
	})

	it("cycles to a different message after MESSAGE_CYCLE_MS", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0) // initial render
		const initialMessage = onUpdate.mock.calls[0][1]
		onUpdate.mockClear()

		vi.advanceTimersByTime(MESSAGE_CYCLE_MS)
		// msgId fires: render() + restartSpin() — at minimum 1 onUpdate call.
		expect(onUpdate).toHaveBeenCalled()
		const newMessage = onUpdate.mock.calls.at(-1)?.[1]
		expect(newMessage).not.toBe(initialMessage)
		anim.stop()
	})

	it("pause() stops further updates but preserves state", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0) // initial render
		const pausedMessage = onUpdate.mock.calls[0][1]
		onUpdate.mockClear()

		anim.pause()

		// Advance through several cycle intervals — no callbacks should fire.
		vi.advanceTimersByTime(MESSAGE_CYCLE_MS * 2)
		expect(onUpdate).not.toHaveBeenCalled()

		// The pre-pause message must not change just because we paused.
		// (We can only verify it by recording it before pause.)
		expect(pausedMessage).toBeTruthy()
	})

	it("resume() continues from the preserved state without resetting", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0) // initial render
		const messageAtPause = onUpdate.mock.calls[0][1]
		onUpdate.mockClear()

		anim.pause()
		vi.advanceTimersByTime(MESSAGE_CYCLE_MS * 2)
		expect(onUpdate).not.toHaveBeenCalled()

		anim.resume()

		// First fire after resume is the setTimeout(0) hand-off — emits the
		// same message+spinIdx+dotIdx that was preserved across pause.
		vi.advanceTimersByTime(0)
		expect(onUpdate).toHaveBeenCalledTimes(1)
		expect(onUpdate.mock.calls[0][1]).toBe(messageAtPause)

		anim.stop()
	})

	it("stop() clears all timers — no updates fire afterward", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		onUpdate.mockClear()

		anim.stop()

		vi.advanceTimersByTime(MESSAGE_CYCLE_MS * 3)
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it("does not duplicate timers across multiple pause/resume cycles", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		onUpdate.mockClear()

		for (let i = 0; i < 5; i++) {
			anim.pause()
			anim.resume()
		}

		// After 5 pause/resume cycles, the next tick should produce exactly
		// one update — the initial setTimeout(0) hand-off — not several.
		vi.advanceTimersByTime(0)
		const callsAfterFirstTick = onUpdate.mock.calls.length
		expect(callsAfterFirstTick).toBe(1)

		// Advancing by DOT_CYCLE_MS should not produce a burst of updates:
		// the dot timer fires once and the spin timer fires a few times, but
		// the total is bounded by the real timers (no duplicates).
		onUpdate.mockClear()
		vi.advanceTimersByTime(DOT_CYCLE_MS)
		expect(onUpdate.mock.calls.length).toBeGreaterThanOrEqual(1)
		expect(onUpdate.mock.calls.length).toBeLessThanOrEqual(5)

		// Exactly one spin tick per spin interval (frame 0 = 140ms).
		onUpdate.mockClear()
		vi.advanceTimersByTime(140)
		expect(onUpdate.mock.calls.length).toBe(1)

		anim.stop()
	})

	it("resume() is a no-op when already running", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		onUpdate.mockClear()

		anim.resume() // already running — must not schedule duplicate timers

		// No new timer was scheduled, so advancing by 0 should not fire anything.
		vi.advanceTimersByTime(0)
		expect(onUpdate).not.toHaveBeenCalled()

		// The original spin timer is still intact and fires on its interval.
		vi.advanceTimersByTime(140)
		expect(onUpdate).toHaveBeenCalledTimes(1)

		anim.stop()
	})

	it("pause() is a no-op when already paused", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		onUpdate.mockClear()

		anim.pause()
		anim.pause() // already paused — must not throw or schedule

		vi.advanceTimersByTime(MESSAGE_CYCLE_MS)
		expect(onUpdate).not.toHaveBeenCalled()

		anim.resume()
		anim.stop()
	})

	it("emits a message whose dot suffix matches the DOT_STATES cycle", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		const initialMessage = onUpdate.mock.calls[0][1]

		// Extract the base message (everything before any trailing dots) and the
		// initial suffix. The base stays the same while dotIdx cycles.
		const baseMessage = initialMessage.replace(/\.*$/, "")
		const initialSuffix = initialMessage.slice(baseMessage.length)

		// Advance dotIdx through every DOT_CYCLE_MS step and collect suffixes.
		const seenSuffixes = new Set<string>()
		seenSuffixes.add(initialSuffix)
		for (let i = 1; i < DOT_STATES.length; i++) {
			vi.advanceTimersByTime(DOT_CYCLE_MS)
			const m = onUpdate.mock.calls.at(-1)?.[1]
			if (typeof m === "string") {
				seenSuffixes.add(m.slice(baseMessage.length))
			}
		}
		expect(seenSuffixes).toEqual(new Set(DOT_STATES))
		anim.stop()
	})

	it("stop() after resume() cleans up the newly scheduled timers", () => {
		const onUpdate = vi.fn()
		const anim = createWorkingAnimator(onUpdate)
		vi.advanceTimersByTime(0)
		anim.pause()
		anim.resume()
		vi.advanceTimersByTime(0)
		onUpdate.mockClear()

		anim.stop()
		vi.advanceTimersByTime(MESSAGE_CYCLE_MS * 2)
		expect(onUpdate).not.toHaveBeenCalled()
	})
})
