import { describe, expect, it } from "vitest"
import { FirstTurnOrientationGuard, ORIENTATION_BLOCK_MESSAGE } from "./first-turn-orientation.js"

describe("FirstTurnOrientationGuard", () => {
	describe("evaluate", () => {
		it("is temporarily disabled and never blocks tool calls", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			expect(guard.evaluate()).toEqual({ block: false })
		})

		it("does not block even when no visible text has been emitted on the first turn", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			const decision = guard.evaluate()
			expect(decision.block).toBe(false)
			expect(decision.reason).toBeUndefined()
		})

		it("does not block even after multiple tool calls on the first turn without text", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			expect(guard.evaluate().block).toBe(false)
			expect(guard.evaluate().block).toBe(false)
			expect(guard.evaluate().block).toBe(false)
		})

		it("does not block on subsequent turns", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(1)
			expect(guard.evaluate().block).toBe(false)
		})
	})

	describe("onTurnStart", () => {
		it("arms first-turn enforcement for turnIndex 0", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(5)
			expect(guard._isFirstTurn()).toBe(false)
			guard.onTurnStart(0)
			expect(guard._isFirstTurn()).toBe(true)
		})

		it("disarms first-turn enforcement for turnIndex > 0", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			expect(guard._isFirstTurn()).toBe(true)
			guard.onTurnStart(1)
			expect(guard._isFirstTurn()).toBe(false)
		})

		it("resets per-turn state on each call", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			guard.recordTextDelta()
			expect(guard._visibleTextSeenThisTurn()).toBe(true)
			guard.onTurnStart(1)
			expect(guard._visibleTextSeenThisTurn()).toBe(false)
		})

		it("resets blockedThisTurn so a new first turn can block again", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			guard.evaluate()
			expect(guard._blockedThisTurn()).toBe(false)
			guard.onTurnStart(0)
			expect(guard._blockedThisTurn()).toBe(false)
		})
	})

	describe("resetSession", () => {
		it("re-arms first-turn enforcement", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(2)
			expect(guard._isFirstTurn()).toBe(false)
			guard.resetSession()
			expect(guard._isFirstTurn()).toBe(true)
		})

		it("resets per-turn state", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			guard.recordTextDelta()
			expect(guard._visibleTextSeenThisTurn()).toBe(true)
			guard.resetSession()
			expect(guard._visibleTextSeenThisTurn()).toBe(false)
		})

		it("resets blockedThisTurn so a new session can block again", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			guard.evaluate()
			guard.resetSession()
			expect(guard._blockedThisTurn()).toBe(false)
		})
	})

	describe("recordTextDelta", () => {
		it("marks visible text as seen", () => {
			const guard = new FirstTurnOrientationGuard()
			expect(guard._visibleTextSeenThisTurn()).toBe(false)
			guard.recordTextDelta()
			expect(guard._visibleTextSeenThisTurn()).toBe(true)
		})
	})
})

describe("ORIENTATION_BLOCK_MESSAGE", () => {
	it("is a stable string containing the key guidance", () => {
		expect(ORIENTATION_BLOCK_MESSAGE).toContain("visible text")
		expect(ORIENTATION_BLOCK_MESSAGE.toLowerCase()).toContain("orient")
	})
})
