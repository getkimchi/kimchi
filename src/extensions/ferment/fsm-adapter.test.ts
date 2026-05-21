import { describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { validateFsmTransitionWithFerment } from "./fsm-adapter.js"

function makeCompleteFerment(): Ferment {
	return {
		id: "ferment-1",
		name: "Complete Ferment",
		status: "complete",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Done",
				goal: "Finish",
				status: "completed",
				steps: [],
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-05-18T00:00:00.000Z",
		updatedAt: "2026-05-18T00:00:00.000Z",
	}
}

describe("validateFsmTransitionWithFerment", () => {
	it("handles a missing ferment before entering the FSM", () => {
		const result = validateFsmTransitionWithFerment(undefined, "ACTIVATE_PHASE", { phaseId: "phase-1" })

		expect(result.error).toBe("Ferment not found.")
	})

	it("does not recommend another lifecycle action for complete ferments", () => {
		const result = validateFsmTransitionWithFerment(makeCompleteFerment(), "ACTIVATE_PHASE", { phaseId: "phase-1" })

		expect(result.error).toContain("This ferment is complete")
		expect(result.error).not.toContain("Recommended next action")
		expect(result.error).not.toContain("complete_ferment")
	})
})
