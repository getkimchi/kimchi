import { describe, expect, it } from "vitest"
import { createDispatchGate } from "./dispatch-gate.js"

describe("createDispatchGate", () => {
	it("starts unarmed", () => {
		expect(createDispatchGate().isArmed()).toBe(false)
	})

	it("arms on arm()", () => {
		const gate = createDispatchGate()
		gate.arm()
		expect(gate.isArmed()).toBe(true)
	})

	it("disarm() consumes the armed state (one-shot)", () => {
		const gate = createDispatchGate()
		gate.arm()
		gate.disarm()
		expect(gate.isArmed()).toBe(false)
	})

	it("disarm() on an unarmed gate is a no-op", () => {
		const gate = createDispatchGate()
		gate.disarm()
		expect(gate.isArmed()).toBe(false)
	})

	it("can be re-armed after disarm", () => {
		const gate = createDispatchGate()
		gate.arm()
		gate.disarm()
		gate.arm()
		expect(gate.isArmed()).toBe(true)
	})
})
