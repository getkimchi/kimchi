import { describe, expect, it } from "vitest"
import { createSessionLogHarness } from "../__mocks__/session-log.js"
import { setActive } from "../ferment/state.js"
import { setFermentV2OrchestrationStatus } from "../ferment-v2/orchestration-state.js"
import { assertDirectorInactive, createOrchestrationActivityProbe } from "./compatibility.js"
import { createDirectorState } from "./plan.js"
import { DirectorStore } from "./state.js"

describe("Director orchestration exclusivity", () => {
	it("allows other orchestration modes only when no Director is active", () => {
		const harness = createSessionLogHarness()
		const store = new DirectorStore(harness)
		expect(() => assertDirectorInactive(harness.sessionManager)).not.toThrow()

		store.commit(createDirectorState("Own the objective", "run-owner"), 0)
		expect(() => assertDirectorInactive(harness.sessionManager)).toThrow(/Director is active/i)

		const current = store.read()
		if (!current) throw new Error("Expected saved Director state")
		store.commit({ ...current, status: "inactive" }, 1)
		expect(() => assertDirectorInactive(harness.sessionManager)).not.toThrow()
	})

	it("detects either legacy Ferment or Ferment V2 activity and releases both", () => {
		const pi = {} as never
		const probe = createOrchestrationActivityProbe(pi)
		expect(probe()).toBe(false)

		setFermentV2OrchestrationStatus(pi, "active")
		expect(probe()).toBe(true)
		setFermentV2OrchestrationStatus(pi, undefined)
		expect(probe()).toBe(false)

		setActive({ objective: "Legacy orchestration" } as never)
		expect(probe()).toBe(true)
		setActive(undefined)
		expect(probe()).toBe(false)
	})
})
