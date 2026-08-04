import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { OrchestratorWriteGuard } from "./review-write-guard.js"

let mockPhase: string | undefined = "review"

vi.mock("./tags.js", () => ({
	getCurrentPhase: () => mockPhase,
}))

afterEach(() => {
	mockPhase = "review"
})

describe("OrchestratorWriteGuard — review phase", () => {
	it("blocks edit during review phase", () => {
		const guard = new OrchestratorWriteGuard(createContext())
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("blocks write during review phase", () => {
		const guard = new OrchestratorWriteGuard(createContext())
		const result = guard.checkToolCall("write")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("does not block read-only tools during review phase", () => {
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("read")).toBeUndefined()
		expect(guard.checkToolCall("bash")).toBeUndefined()
		expect(guard.checkToolCall("grep")).toBeUndefined()
	})

	it("does not treat Agent tool calls as a reset signal on the guard", () => {
		const guard = new OrchestratorWriteGuard(createContext())
		// The extension short-circuits Agent calls in tool_call; the guard never
		// receives them. Verifying that calling it directly with "Agent" is a no-op.
		expect(guard.checkToolCall("Agent")).toBeUndefined()
	})

	it("blocks every edit attempt, not just the first", () => {
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("write")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})
})

describe("OrchestratorWriteGuard — build phase", () => {
	it("allows edits in build phase before any subagent returns", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("write")).toBeUndefined()
	})

	it("steers after threshold edits following a subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2 })
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses higher triage thresholds after an aborted subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "aborted", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses higher triage thresholds after a stopped subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "stopped", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses higher triage thresholds after a status error outcome", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "error", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses normal thresholds after a successful subagent return with explicit details", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2 })
		guard.recordSubagentReturn({ status: "completed", outcome: "completed", subagentType: "Builder" })
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses triage thresholds after a non-terminal but valid subagent outcome", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "queued", outcome: "completed" })
		expect(guard.getState().subagentReturnedInBuild).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(false)
		// 3 edits under the triage threshold of 4 should not trigger a steer.
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("treats status:steered, outcome:completed as a successful subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "steered", outcome: "completed" })
		expect(guard.getState().subagentReturnedInBuild).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(true)
		// Normal thresholds: 1st edit allowed, 2nd triggers steer.
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses triage thresholds for an unknown subagent outcome", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseTriageBlockThreshold: 8,
		})
		// Cast to never so we can pass arbitrary values that aren't valid AgentOutcomeSummary fields.
		guard.recordSubagentReturn({ status: "weird" as never, outcome: "mystery" as never })
		expect(guard.getState().subagentReturnedInBuild).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(false)
	})

	it("steers only once then allows edits until block threshold", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		guard.checkToolCall("edit")
		expect(guard.getState().buildSteered).toBe(true)
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("blocks after block threshold edits following a subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 4; i++) guard.checkToolCall("edit")
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("keeps blocking on every edit after block threshold", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 5; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("write")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("does not track subagent returns outside build phase", () => {
		mockPhase = "plan"
		const guard = new OrchestratorWriteGuard(createContext())
		guard.recordSubagentReturn()
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
	})

	it("resets build-phase state when a subagent returns outside build phase", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2 })
		guard.recordSubagentReturn({ status: "completed", outcome: "completed" })
		expect(guard.getState().subagentReturnedInBuild).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(true)

		// Subagent returns while the session is in plan phase.
		mockPhase = "plan"
		guard.recordSubagentReturn({ status: "completed", outcome: "completed" })
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
		expect(guard.getState().lastSubagentSuccessful).toBe(false)

		// Returning to build should not inherit the earlier build-phase state.
		mockPhase = "build"
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("uses default threshold of 2", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext())
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})
})

describe("OrchestratorWriteGuard — other phases", () => {
	it("does not block edits outside review phase", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("does not block edits in plan phase", () => {
		mockPhase = "plan"
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("does nothing when phase is undefined", () => {
		mockPhase = undefined
		const guard = new OrchestratorWriteGuard(createContext())
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("resets build tracking when phase changes to non-build/review", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard(createContext(), { buildPhaseThreshold: 2 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		mockPhase = "plan"
		guard.checkToolCall("edit")
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
	})
})

describe("OrchestratorWriteGuard — threshold order assertions", () => {
	it("throws when block threshold is not greater than steer threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard(createContext(), {
					buildPhaseThreshold: 5,
					buildPhaseBlockThreshold: 5,
				}),
		).toThrow(/buildPhaseBlockThreshold/)
	})

	it("throws when triage block threshold is not greater than triage steer threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard(createContext(), {
					buildPhaseTriageThreshold: 8,
					buildPhaseTriageBlockThreshold: 8,
				}),
		).toThrow(/buildPhaseTriageBlockThreshold/)
	})

	it("throws when triage threshold is not greater than normal threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard(createContext(), {
					buildPhaseThreshold: 4,
					buildPhaseTriageThreshold: 4,
				}),
		).toThrow(/buildPhaseTriageThreshold/)
	})

	it("throws when triage block threshold is not greater than normal block threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard(createContext(), {
					buildPhaseBlockThreshold: 8,
					buildPhaseTriageBlockThreshold: 8,
				}),
		).toThrow(/buildPhaseTriageBlockThreshold/)
	})

	it("accepts default threshold ordering", () => {
		expect(() => new OrchestratorWriteGuard(createContext())).not.toThrow()
	})
})
