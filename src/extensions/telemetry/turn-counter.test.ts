import { describe, expect, it } from "vitest"
import { TurnCounter } from "./turn-counter.js"

describe("TurnCounter", () => {
	it("advanceTurn counts LLM turns 1-based and never resets", () => {
		const turns = new TurnCounter()
		expect(turns.advanceTurn()).toBe(1)
		expect(turns.advanceTurn()).toBe(2)
		expect(turns.advanceTurn()).toBe(3)
	})

	it("stampUserMessageTurn and advanceTurn share one strictly-increasing counter", () => {
		const turns = new TurnCounter()
		// First prompt is stamped with the turn its run will start in; the
		// run's first turn_start returns the same number.
		expect(turns.stampUserMessageTurn()).toBe(1)
		expect(turns.advanceTurn()).toBe(1)
		expect(turns.advanceTurn()).toBe(2)
		expect(turns.advanceTurn()).toBe(3)
		// Next prompt: stamped with the turn its run starts in (4).
		expect(turns.stampUserMessageTurn()).toBe(4)
		expect(turns.advanceTurn()).toBe(4)
	})

	it("a prompt that never starts a turn does not break strict monotonicity", () => {
		const turns = new TurnCounter()
		expect(turns.advanceTurn()).toBe(1)
		expect(turns.advanceTurn()).toBe(2)
		// Prompt submitted but the run fails before any turn starts.
		expect(turns.stampUserMessageTurn()).toBe(3)
		// The next real turn and the next prompt's stamp move past it.
		expect(turns.advanceTurn()).toBe(3)
		expect(turns.stampUserMessageTurn()).toBe(4)
		expect(turns.advanceTurn()).toBe(4)
	})

	it("resetTurns starts counting again", () => {
		const turns = new TurnCounter()
		turns.advanceTurn()
		turns.stampUserMessageTurn()
		turns.resetTurns()
		expect(turns.stampUserMessageTurn()).toBe(1)
		expect(turns.advanceTurn()).toBe(1)
	})
})
