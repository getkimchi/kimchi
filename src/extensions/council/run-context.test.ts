import { afterEach, describe, expect, it, vi } from "vitest"
import { CouncilRunContext, type RunBudgetLimits, type RunFailure } from "./run-context.js"

const limits: RunBudgetLimits = {
	overallTimeoutMs: 1_000,
	maxLogicalCalls: 2,
	maxPhysicalAttempts: 3,
	maxConcurrentCalls: 2,
	maxAggregateInputTokens: 100,
	maxAggregateOutputTokens: 50,
	maxEvidenceBytes: 100,
	maxStructuredBytes: 100,
}

afterEach(() => vi.useRealTimers())

describe("CouncilRunContext", () => {
	it("atomically reserves parallel attempts and reconciles actual usage", () => {
		const run = new CouncilRunContext(limits)
		const first = run.reserveAttempt({ inputTokens: 40, outputTokens: 20 })
		const second = run.reserveAttempt({ inputTokens: 40, outputTokens: 20 })

		expect(() => run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })).toThrowError(
			/Council run budget exceeded: maxConcurrentCalls/,
		)
		first.reconcile({ inputTokens: 10, outputTokens: 5 })
		second.reconcile({ inputTokens: 20, outputTokens: 10 })
		expect(run.snapshot()).toMatchObject({
			physicalAttempts: 2,
			activeCalls: 0,
			peakConcurrentCalls: 2,
			inputTokens: 30,
			outputTokens: 15,
		})
		run.close()
	})

	it("does not count a rejected physical attempt", () => {
		const run = new CouncilRunContext({ ...limits, maxPhysicalAttempts: 2, maxConcurrentCalls: 3 })
		const first = run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })
		const second = run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })

		expect(() => run.reserveAttempt({ inputTokens: 1, outputTokens: 1 })).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxPhysicalAttempts" }),
		)
		expect(run.snapshot()).toMatchObject({ physicalAttempts: 2, activeCalls: 2 })
		first.release()
		second.release()
		expect(run.snapshot()).toMatchObject({ physicalAttempts: 2, activeCalls: 0 })
		run.close()
	})

	it("aborts the run when a logical-call budget is exceeded", () => {
		const run = new CouncilRunContext(limits)
		run.beginLogicalCall()
		run.beginLogicalCall()

		expect(() => run.beginLogicalCall()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxLogicalCalls" }),
		)
		expect(run.snapshot().logicalCalls).toBe(2)
		expect(run.signal.aborted).toBe(true)
		run.close()
	})

	it("tracks the largest evidence packet without accumulating repeated packets", () => {
		const evidence = new CouncilRunContext(limits)
		evidence.reserveEvidence(90)
		evidence.reserveEvidence(90)
		expect(evidence.snapshot().evidenceBytes).toBe(90)
		evidence.close()

		const oversized = new CouncilRunContext(limits)
		expect(() => oversized.reserveEvidence(101)).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxEvidenceBytes" }),
		)
		expect(oversized.snapshot().evidenceBytes).toBe(0)
		oversized.close()
	})

	it("does not record rejected structured bytes", () => {
		const structured = new CouncilRunContext(limits)
		structured.reserveStructured(90)
		expect(() => structured.reserveStructured(20)).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxStructuredBytes" }),
		)
		expect(structured.snapshot().structuredBytes).toBe(90)
		structured.close()
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

	it("keeps cumulative usage when recreated between tool rounds", () => {
		vi.useFakeTimers({ now: 100 })
		const first = new CouncilRunContext(limits)
		first.beginLogicalCall()
		first.reserveAttempt({ inputTokens: 30, outputTokens: 15 }).reconcile({
			inputTokens: 20,
			outputTokens: 10,
		})
		first.reserveEvidence(25)
		first.reserveStructured(30)
		const initialSnapshot = { ...first.snapshot(), activeCalls: 7 }
		first.close()

		const second = new CouncilRunContext(limits, {
			startedAt: first.startedAt,
			deadlineAt: first.deadlineAt,
			initialSnapshot,
		})
		second.beginLogicalCall()
		second.reserveAttempt({ inputTokens: 10, outputTokens: 5 }).reconcile({
			inputTokens: 10,
			outputTokens: 5,
		})

		expect(second.snapshot()).toMatchObject({
			logicalCalls: 2,
			physicalAttempts: 2,
			activeCalls: 0,
			peakConcurrentCalls: 1,
			inputTokens: 30,
			outputTokens: 15,
			evidenceBytes: 25,
			structuredBytes: 30,
		})
		expect(() => second.beginLogicalCall()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "budget_exceeded", limit: "maxLogicalCalls" }),
		)
		expect(second.snapshot().logicalCalls).toBe(2)
		second.close()
	})

	it("keeps one absolute deadline when recreated", () => {
		vi.useFakeTimers({ now: 10 })
		const first = new CouncilRunContext(limits, { callerTimeoutMs: 100 })
		vi.advanceTimersByTime(60)
		const snapshot = first.snapshot()
		first.close()

		const second = new CouncilRunContext(limits, {
			startedAt: first.startedAt,
			deadlineAt: first.deadlineAt,
			initialSnapshot: snapshot,
		})
		expect(second.remainingMs(500)).toBe(40)
		vi.advanceTimersByTime(40)
		expect(() => second.throwIfAborted()).toThrowError(
			expect.objectContaining<Partial<RunFailure>>({ code: "deadline_exceeded" }),
		)
		second.close()
	})

	it("fails immediately when an inherited deadline is already expired", () => {
		vi.useFakeTimers({ now: 200 })
		const run = new CouncilRunContext(limits, { startedAt: 10, deadlineAt: 110 })

		expect(run.signal.aborted).toBe(true)
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
