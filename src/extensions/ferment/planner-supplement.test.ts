import { describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { buildPlannerSupplement } from "./planner-supplement.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"

function makeRuntime(): FermentRuntime {
	const now = "2026-01-01T00:00:00.000Z"
	const ferment: Ferment = {
		id: "ferment-1",
		name: "Runtime Plan",
		status: "running",
		mode: "plan",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Previous Phase",
				goal: "Build the base",
				status: "completed",
				steps: [],
				grade: {
					grade: "D",
					rationale: "Important requirements were missed.",
					deltas: [
						{
							category: "scope",
							expected: "Handle edge cases",
							actual: "Only happy path",
							severity: "major",
						},
					],
					gradedAt: now,
				},
			},
		],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	}
	return {
		...createDefaultFermentRuntime(),
		getActive: () => ferment,
		getCorrectiveStep: (fermentId, phaseId) =>
			fermentId === "ferment-1" && phaseId === "phase-1" ? "Add an explicit edge-case verification step." : undefined,
	}
}

describe("buildPlannerSupplement", () => {
	it("uses injected active ferment and corrective-step state", () => {
		const supplement = buildPlannerSupplement(makeRuntime())

		expect(supplement).toContain('ferment "Runtime Plan"')
		expect(supplement).toContain("## Self-Improvement Feedback")
		expect(supplement).toContain("Important requirements were missed.")
		expect(supplement).toContain("Add an explicit edge-case verification step.")
	})
})
