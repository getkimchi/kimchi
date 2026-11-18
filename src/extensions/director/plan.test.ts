import { describe, expect, it } from "vitest"
import { assertValidDirectorPlan, createDirectorState, renderDirectorStatus } from "./plan.js"

describe("Director plan invariants and status", () => {
	it("rejects duplicate task ids and dependency cycles", () => {
		const duplicate = createDirectorState("Invalid duplicate", "run-duplicate").plan
		duplicate.tasks = [
			{ id: "same", title: "First", status: "pending", dependsOn: [] },
			{ id: "same", title: "Second", status: "pending", dependsOn: [] },
		]
		expect(() => assertValidDirectorPlan(duplicate)).toThrow(/duplicate/i)

		const cycle = createDirectorState("Invalid cycle", "run-cycle").plan
		cycle.tasks = [
			{ id: "a", title: "A", status: "pending", dependsOn: ["b"] },
			{ id: "b", title: "B", status: "pending", dependsOn: ["a"] },
		]
		expect(() => assertValidDirectorPlan(cycle)).toThrow(/cycle|cyclic/i)
	})

	it("renders a compact progress report instead of worker transcripts", () => {
		const state = createDirectorState("Render concise status", "run-status")
		state.plan.currentPhase = "build"
		state.plan.tasks = [
			{ id: "done", title: "Persist plan", status: "completed", dependsOn: [] },
			{ id: "next", title: "Test resume", status: "running", dependsOn: ["done"] },
		]
		state.plan.workers["agent-1"] = {
			id: "agent-1",
			type: "Builder",
			description: "Implement resume",
			status: "running",
			disposition: "owned",
			result: "Raw transcript that must not flood the progress display",
			artifactPaths: [],
		}

		const report = renderDirectorStatus(state)
		expect(report).toContain("Director active: Render concise status")
		expect(report).toContain("Phase: build · revision 0")
		expect(report).toContain("Tasks: 1 completed · 1 running")
		expect(report).toContain("agent-1")
		expect(report).not.toContain("Raw transcript")
	})

	it("caps worker progress without hiding the remaining count", () => {
		const state = createDirectorState("Bounded progress", "run-bounded-status")
		for (let index = 1; index <= 16; index++) {
			state.plan.workers[`worker-${index}`] = {
				id: `worker-${index}`,
				type: "Builder",
				description: "Parallel work",
				status: "running",
				disposition: "owned",
				artifactPaths: [],
			}
		}
		const report = renderDirectorStatus(state)
		expect(report.match(/^- /gm)).toHaveLength(13)
		expect(report).toContain("- worker-12 Builder running (owned)")
		expect(report).toContain("… 4 more")
	})
})
