import { afterEach, describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { registerAgents } from "../agents/personas/agent-types.js"
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
	}
}

describe("buildPlannerSupplement", () => {
	afterEach(() => {
		registerAgents(new Map())
	})

	it("uses injected active ferment", () => {
		const supplement = buildPlannerSupplement(makeRuntime())

		expect(supplement).toContain('ferment "Runtime Plan"')
		// Phase-grade-based self-improvement was removed when per-phase grading
		// went away. The corrective-step pipeline now lives entirely inside
		// the block-retry loop at complete_phase — surfaced via tool error
		// text, not via a planner-prompt section.
		expect(supplement).not.toContain("## Self-Improvement Feedback")
	})

	it("lists default subagent types when the registry is populated", () => {
		// registerAgents always re-loads DEFAULT_AGENTS, even if the user-agent
		// map is empty — that's the same path the agents extension uses on
		// session_start, so we exercise it here.
		registerAgents(new Map())

		const supplement = buildPlannerSupplement(makeRuntime())
		expect(supplement).toContain("Available subagent types")
		expect(supplement).toContain("**Explore**")
	})

	it("warns against turning fixed interfaces into configurable options", () => {
		const supplement = buildPlannerSupplement(makeRuntime())

		expect(supplement).toContain("fixed output path")
		expect(supplement).toContain("fixed runtime interface")
		expect(supplement).toContain("extra CLI argument")
		expect(supplement).toContain("config option")
		expect(supplement).toContain("flexible interface")
	})
})
