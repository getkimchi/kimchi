import { afterEach, describe, expect, it, vi } from "vitest"
import { CouncilRunContext, type RunBudgetLimits, type RunFailure } from "./run-context.js"

const limits: RunBudgetLimits = {
	overallTimeoutMs: 1_000,
	maxLogicalCalls: 2,
	maxPhysicalAttempts: 3,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 100,
	maxAggregateOutputTokens: 50,
	maxEstimatedCostUsd: 1,
	maxEvidenceBytes: 100,
	maxStructuredBytes: 100,
}

afterEach(() => vi.useRealTimers())

describe("CouncilRunContext", () => {
	it("atomically reserves parallel attempts and reconciles actual usage", () => {
		const run = new CouncilRunContext(limits)
		const first = run.reserveAttempt({ inputTokens: 40, outputTokens: 20, costUsd: 0.4 })
		const second = run.reserveAttempt({ inputTokens: 40, outputTokens: 20, costUsd: 0.4 })

		expect(() => run.reserveAttempt({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 })).toThrowError(
			/Council run budget exceeded: maxConcurrentCalls/,
		)
		first.reconcile({ inputTokens: 10, outputTokens: 5, costUsd: 0.1 })
		second.reconcile({ inputTokens: 20, outputTokens: 10, costUsd: 0.2 })
		expect(run.snapshot()).toMatchObject({
			physicalAttempts: 3,
			activeCalls: 0,
			peakConcurrentCalls: 2,
			inputTokens: 30,
			outputTokens: 15,
		})
		expect(run.snapshot().estimatedCostUsd).toBeCloseTo(0.3)
		run.close()
	})

	it("aborts the run when a logical-call budget is exceeded", () => {
		const run = new CouncilRunContext(limits)
		run.beginLogicalCall()
		run.beginLogicalCall()

		expect(() => run.beginLogicalCall()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxLogicalCalls" }),
		)
		expect(run.signal.aborted).toBe(true)
		run.close()
	})

	it("uses the shorter caller timeout as the whole-run deadline", () => {
		vi.useFakeTimers({ now: 10 })
		const run = new CouncilRunContext(limits, { callerTimeoutMs: 100 })
		expect(run.remainingMs(500)).toBe(100)

		vi.advanceTimersByTime(100)
		expect(() => run.throwIfAborted()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "deadline_exceeded" }),
		)
		run.close()
	})

	it("propagates caller cancellation", () => {
		const caller = new AbortController()
		const run = new CouncilRunContext(limits, { callerSignal: caller.signal })
		caller.abort()

		expect(() => run.throwIfAborted()).toThrowError(expect.objectContaining<Partial<RunFailure>>({ code: "aborted" }))
		run.close()
	})
})
