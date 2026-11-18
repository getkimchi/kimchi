import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	currentRecallSignal,
	mergeRecallSignal,
	RecallDeadline,
	RecallDeadlineError,
	withRecallDeadline,
} from "./deadline.js"

describe("RecallDeadline", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("aborts at its deadline and leaves no selected or delivered trace", () => {
		const deadline = new RecallDeadline({ scheduledStep: "before-agent-start", generation: 3, timeoutMs: 500 })
		expect(deadline.signal.aborted).toBe(false)
		vi.advanceTimersByTime(500)
		expect(deadline.signal.aborted).toBe(true)
		expect(deadline.remainingMs).toBe(0)
		expect(deadline.conclusion).toBe("timed-out")
		expect(deadline.trace()).toMatchObject({ recall_id: deadline.id, scheduledStep: "before-agent-start" })
		expect(() => deadline.assertActive()).toThrow("memory recall timed-out")
		deadline.dispose()
	})

	it("rejects a stale generation without mutating delivery state", () => {
		const deadline = new RecallDeadline({ scheduledStep: "step-budget", generation: 1, timeoutMs: 500 })
		expect(() => deadline.markDelivered("selected", 2)).toThrow("memory recall droppedStale")
		expect(deadline.conclusion).toBe("droppedStale")
		expect(deadline.canDeliver(2)).toBe(false)
		expect(deadline.status).toBeUndefined()
		deadline.dispose()
	})

	it("keeps asynchronous request scopes isolated between sessions", async () => {
		const a = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 500, id: "a" })
		const b = new RecallDeadline({ scheduledStep: "user-turn", generation: 1, timeoutMs: 500, id: "b" })
		let bSignal: AbortSignal | undefined
		let bMerged: AbortSignal | undefined
		const other = withRecallDeadline(b, async () => {
			bSignal = currentRecallSignal()
			bMerged = mergeRecallSignal()
			await Promise.resolve()
		})
		const own = withRecallDeadline(a, async () => {
			expect(currentRecallSignal()).toBe(a.signal)
			expect(bSignal).toBe(b.signal)
			a.cancel("cancelled")
			expect(b.signal.aborted).toBe(false)
			expect(bMerged?.aborted).toBe(false)
			await expect(ownSignal()).rejects.toThrow("memory recall cancelled")
		})
		await Promise.all([own, other])
		a.dispose()
		b.dispose()

		async function ownSignal(): Promise<string> {
			const signal = mergeRecallSignal()
			expect(signal).toBe(a.signal)
			await Promise.resolve()
			signal?.throwIfAborted()
			return "unreachable"
		}
	})

	it("propagates a parent abort and distinguishes selection from attachment", () => {
		const parent = new AbortController()
		const deadline = new RecallDeadline({
			scheduledStep: "before-agent-start",
			generation: 1,
			timeoutMs: 100,
			parentSignal: parent.signal,
		})
		deadline.markDelivered("selected")
		expect(deadline.status).toBe("selected")
		expect(deadline.conclusion).toBe("selected")
		deadline.markDelivered("attachedToTurn")
		expect(deadline.conclusion).toBe("attachedToTurn")
		parent.abort()
		expect(deadline.signal.aborted).toBe(true)
		expect(() => deadline.assertActive()).toThrow(RecallDeadlineError)
		deadline.dispose()
	})
})
