import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { FirstTurnOrientationGuard, ORIENTATION_BLOCK_MESSAGE } from "./first-turn-orientation.js"
import firstTurnOrientationExtension from "./first-turn-orientation.js"
import { TOOL_CALL_EVENTS } from "./tool-call-events.js"

describe("FirstTurnOrientationGuard", () => {
	describe("evaluate", () => {
		it("blocks the first tool_call on the first turn when no visible text has been emitted", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			const decision = guard.evaluate()
			expect(decision.block).toBe(true)
			expect(decision.reason).toBe(ORIENTATION_BLOCK_MESSAGE)
		})

		it("does not block when visible text was emitted before the tool_call", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			guard.recordTextDelta()
			const decision = guard.evaluate()
			expect(decision.block).toBe(false)
		})

		it("does not block on subsequent turns (turnIndex > 0)", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(1)
			const decision = guard.evaluate()
			expect(decision.block).toBe(false)
		})

		it("does not block a second tool_call in the same turn after the first block (block-once-per-turn)", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			const first = guard.evaluate()
			expect(first.block).toBe(true)
			const second = guard.evaluate()
			expect(second.block).toBe(false)
			const third = guard.evaluate()
			expect(third.block).toBe(false)
		})

		it("does not block if text appears after the first block in the same turn", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			const first = guard.evaluate()
			expect(first.block).toBe(true)
			// Model retries, this time emitting visible text first
			guard.recordTextDelta()
			const second = guard.evaluate()
			expect(second.block).toBe(false)
		})

		it("does not block on subsequent turns even after a first-turn block (resets per turn)", () => {
			const guard = new FirstTurnOrientationGuard()
			guard.onTurnStart(0)
			expect(guard.evaluate().block).toBe(true)
			// New turn — fresh state
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
			expect(guard.evaluate().block).toBe(true)
			expect(guard._blockedThisTurn()).toBe(true)
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
			expect(guard.evaluate().block).toBe(true)
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

describe("firstTurnOrientationExtension — domain event emission", () => {
	function createMockPi() {
		const handlers = new Map<string, Array<(event: unknown) => unknown>>()
		const emit = vi.fn()
		const api = {
			on: vi.fn((event: string, handler: (e: unknown) => unknown) => {
				if (!handlers.has(event)) handlers.set(event, [])
				handlers.get(event)?.push(handler)
			}),
			events: { emit },
		} as unknown as ExtensionAPI
		return { api, handlers, emit }
	}

	function fire(handlers: Map<string, Array<(event: unknown) => unknown>>, event: string, payload: unknown) {
		const list = handlers.get(event) ?? []
		let blockResult: { block: true; reason: string } | undefined
		for (const h of list) {
			const result = h(payload) as { block?: boolean; reason?: string } | undefined
			if (result?.block) {
				blockResult = { block: true, reason: result.reason ?? "" }
			}
		}
		return blockResult
	}

	it("emits first_turn_orientation:block with toolCallId and reason when blocking", () => {
		const { api, handlers, emit } = createMockPi()
		firstTurnOrientationExtension(api)

		fire(handlers, "turn_start", { turnIndex: 0 })
		const result = fire(handlers, "tool_call", { toolCallId: "tc-1", toolName: "bash" })

		expect(result?.block).toBe(true)
		expect(result?.reason).toBe(ORIENTATION_BLOCK_MESSAGE)
		expect(emit).toHaveBeenCalledWith(TOOL_CALL_EVENTS.BLOCK, {
			toolCallId: "tc-1",
			toolName: "bash",
			reason: ORIENTATION_BLOCK_MESSAGE,
			guard: "first_turn_orientation",
		})
	})

	it("does NOT emit the domain event when not blocking (visible text was seen)", () => {
		const { api, handlers, emit } = createMockPi()
		firstTurnOrientationExtension(api)

		fire(handlers, "turn_start", { turnIndex: 0 })
		fire(handlers, "message_update", {
			assistantMessageEvent: { type: "text_delta" },
		})
		const result = fire(handlers, "tool_call", { toolCallId: "tc-2", toolName: "bash" })

		expect(result?.block).toBeFalsy()
		expect(emit).not.toHaveBeenCalled()
	})

	it("does NOT emit the domain event on subsequent turns (turnIndex > 0)", () => {
		const { api, handlers, emit } = createMockPi()
		firstTurnOrientationExtension(api)

		fire(handlers, "turn_start", { turnIndex: 5 })
		fire(handlers, "tool_call", { toolCallId: "tc-3", toolName: "bash" })

		expect(emit).not.toHaveBeenCalled()
	})

	it("emits the domain event only on the first blocked call (block-once-per-turn)", () => {
		const { api, handlers, emit } = createMockPi()
		firstTurnOrientationExtension(api)

		fire(handlers, "turn_start", { turnIndex: 0 })
		fire(handlers, "tool_call", { toolCallId: "tc-A", toolName: "bash" })
		fire(handlers, "tool_call", { toolCallId: "tc-B", toolName: "bash" })

		expect(emit).toHaveBeenCalledTimes(1)
		expect(emit).toHaveBeenCalledWith(TOOL_CALL_EVENTS.BLOCK, {
			toolCallId: "tc-A",
			toolName: "bash",
			reason: ORIENTATION_BLOCK_MESSAGE,
			guard: "first_turn_orientation",
		})
	})

	it("does NOT emit the domain event for empty tool names", () => {
		const { api, handlers, emit } = createMockPi()
		firstTurnOrientationExtension(api)

		fire(handlers, "turn_start", { turnIndex: 0 })
		fire(handlers, "tool_call", { toolCallId: "tc-4", toolName: "" })

		expect(emit).not.toHaveBeenCalled()
	})
})
