import { describe, expect, it } from "vitest"
import { OrchestratorWriteGuard } from "./review-write-guard.js"

describe("OrchestratorWriteGuard — arming", () => {
	it("does not steer or block before a subagent returns", () => {
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("write")).toBeUndefined()
	})

	it("arms when a subagent returns", () => {
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.getState().armed).toBe(true)
	})

	it("does not treat Agent tool calls as a reset signal", () => {
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("Agent")).toBeUndefined()
	})

	it("does not block read-only tools", () => {
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("read")).toBeUndefined()
		expect(guard.checkToolCall("bash")).toBeUndefined()
		expect(guard.checkToolCall("grep")).toBeUndefined()
	})
})

describe("OrchestratorWriteGuard — success thresholds", () => {
	it("allows the first edit after a subagent return, steers on the second", () => {
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("steers only once then allows edits until block threshold", () => {
		const guard = new OrchestratorWriteGuard({ steerThreshold: 2, blockThreshold: 5 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		guard.checkToolCall("edit")
		expect(guard.getState().steered).toBe(true)
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("blocks after block threshold edits following a subagent return", () => {
		const guard = new OrchestratorWriteGuard({ steerThreshold: 2, blockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 4; i++) guard.checkToolCall("edit")
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("keeps blocking on every edit after block threshold", () => {
		const guard = new OrchestratorWriteGuard({ steerThreshold: 2, blockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 5; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("write")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("uses default threshold of 2", () => {
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("treats status:steered, outcome:completed as a successful subagent return", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "steered", outcome: "completed" })
		expect(guard.getState().armed).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(true)
		// Normal thresholds: 1st edit allowed, 2nd triggers steer.
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses normal thresholds after a successful subagent return with explicit details", () => {
		const guard = new OrchestratorWriteGuard({ steerThreshold: 2 })
		guard.recordSubagentReturn({ status: "completed", outcome: "completed", subagentType: "Builder" })
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})
})

describe("OrchestratorWriteGuard — triage thresholds", () => {
	it("uses higher triage thresholds after an aborted subagent return", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "aborted", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses higher triage thresholds after a stopped subagent return", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "stopped", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses higher triage thresholds after a status error outcome", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "error", outcome: "failed" })
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses triage thresholds after a non-terminal but valid subagent outcome", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "queued", outcome: "completed" })
		expect(guard.getState().armed).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(false)
		// 3 edits under the triage threshold of 4 should not trigger a steer.
		for (let i = 0; i < 3; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("uses triage thresholds for an unknown subagent outcome", () => {
		const guard = new OrchestratorWriteGuard({
			steerThreshold: 2,
			triageSteerThreshold: 4,
			triageBlockThreshold: 8,
		})
		guard.recordSubagentReturn({ status: "weird" as never, outcome: "mystery" as never })
		expect(guard.getState().armed).toBe(true)
		expect(guard.getState().lastSubagentSuccessful).toBe(false)
	})
})

describe("OrchestratorWriteGuard — reset", () => {
	it("reset clears armed state and counters", () => {
		const guard = new OrchestratorWriteGuard({ steerThreshold: 2 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		guard.reset()
		expect(guard.getState().armed).toBe(false)
		expect(guard.getState().writeCount).toBe(0)
		// After reset, edits are unconstrained until the next subagent return.
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})
})

describe("OrchestratorWriteGuard — threshold order assertions", () => {
	it("throws when block threshold is not greater than steer threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard({
					steerThreshold: 5,
					blockThreshold: 5,
				}),
		).toThrow(/blockThreshold/)
	})

	it("throws when triage block threshold is not greater than triage steer threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard({
					triageSteerThreshold: 8,
					triageBlockThreshold: 8,
				}),
		).toThrow(/triageBlockThreshold/)
	})

	it("throws when triage threshold is not greater than normal threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard({
					steerThreshold: 4,
					triageSteerThreshold: 4,
				}),
		).toThrow(/triageSteerThreshold/)
	})

	it("throws when triage block threshold is not greater than normal block threshold", () => {
		expect(
			() =>
				new OrchestratorWriteGuard({
					blockThreshold: 8,
					triageBlockThreshold: 8,
				}),
		).toThrow(/triageBlockThreshold/)
	})

	it("accepts default threshold ordering", () => {
		expect(() => new OrchestratorWriteGuard()).not.toThrow()
	})
})
