import { afterEach, describe, expect, it, vi } from "vitest"
import {
	notifyPlanReviewClosed,
	resetPlanReviewClosedListenersForTests,
	subscribePlanReviewClosed,
} from "./plan-review-state.js"

afterEach(() => {
	resetPlanReviewClosedListenersForTests()
})

describe("plan-review closed notifier", () => {
	it("delivers the sessionId to subscribers", () => {
		const listener = vi.fn()
		subscribePlanReviewClosed(listener)
		notifyPlanReviewClosed("session-a")
		expect(listener).toHaveBeenCalledWith("session-a")
	})

	it("supports multiple listeners in registration order", () => {
		const calls: string[] = []
		subscribePlanReviewClosed((id) => calls.push(`first:${id}`))
		subscribePlanReviewClosed((id) => calls.push(`second:${id}`))
		notifyPlanReviewClosed("s")
		expect(calls).toEqual(["first:s", "second:s"])
	})

	it("stops delivering after unsubscribe", () => {
		const listener = vi.fn()
		const unsubscribe = subscribePlanReviewClosed(listener)
		unsubscribe()
		notifyPlanReviewClosed("session-a")
		expect(listener).not.toHaveBeenCalled()
	})

	it("does not leak notifications across listeners for other sessions (listeners filter by sessionId)", () => {
		const sessionA = vi.fn()
		const sessionB: string[] = []
		subscribePlanReviewClosed(sessionA)
		subscribePlanReviewClosed((id) => {
			if (id === "b") sessionB.push(id)
		})
		notifyPlanReviewClosed("a")
		expect(sessionA).toHaveBeenCalledWith("a")
		expect(sessionB).toEqual([])
	})
})
