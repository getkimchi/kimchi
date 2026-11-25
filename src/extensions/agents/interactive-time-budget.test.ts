import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInteractiveTimeBudget } from "./interactive-time-budget.js"

describe("interactive time budget", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("pauses and resumes the expiry deadline", () => {
		let currentTimeMs = 0
		const clock = () => currentTimeMs
		const budget = createInteractiveTimeBudget(10, currentTimeMs, clock)
		const expire = vi.fn()
		budget.setOnExpire(expire)
		try {
			vi.advanceTimersByTime(4000)
			currentTimeMs = 4000
			const release = budget.pause()
			vi.advanceTimersByTime(6000)
			currentTimeMs = 10_000
			expect(expire).not.toHaveBeenCalled()
			expect(budget.getRemainingMs()).toBe(6000)
			currentTimeMs = 10_000
			release()
			vi.advanceTimersByTime(5999)
			currentTimeMs = 15_999
			expect(expire).not.toHaveBeenCalled()
			vi.advanceTimersByTime(1)
			currentTimeMs = 16_000
			expect(expire).toHaveBeenCalledOnce()
		} finally {
			budget.dispose()
		}
	})

	it("resumes only after the last nested hold and cancels cleanly", () => {
		let currentTimeMs = 0
		const budget = createInteractiveTimeBudget(5, currentTimeMs, () => currentTimeMs)
		const expire = vi.fn()
		budget.setOnExpire(expire)
		try {
			const first = budget.pause()
			const second = budget.pause()
			const pausedRemaining = budget.getRemainingMs()
			first()
			first()
			currentTimeMs = 20_000
			vi.advanceTimersByTime(20_000)
			expect(expire).not.toHaveBeenCalled()
			expect(budget.getRemainingMs()).toBe(pausedRemaining)
			second()
			expect(budget.getRemainingMs()).toBe(pausedRemaining)
			budget.dispose()
			vi.advanceTimersByTime(20_000)
			expect(expire).not.toHaveBeenCalled()
		} finally {
			budget.dispose()
		}
	})

	it("does not arm an expiry timer for an unlimited run", () => {
		const budget = createInteractiveTimeBudget(0, Date.now())
		const expire = vi.fn()
		budget.setOnExpire(expire)
		try {
			expect(vi.getTimerCount()).toBe(0)
			vi.advanceTimersByTime(1_000_000)
			expect(expire).not.toHaveBeenCalled()
		} finally {
			budget.dispose()
		}
	})

	it("reports an unlimited remainder for an unlimited run, also while paused", () => {
		const budget = createInteractiveTimeBudget(0, Date.now())
		try {
			expect(budget.getRemainingMs()).toBe(Number.POSITIVE_INFINITY)
			vi.advanceTimersByTime(60_000)
			const release = budget.pause()
			expect(budget.getRemainingMs()).toBe(Number.POSITIVE_INFINITY)
			release()
			expect(budget.getRemainingMs()).toBe(Number.POSITIVE_INFINITY)
		} finally {
			budget.dispose()
		}
	})
})
