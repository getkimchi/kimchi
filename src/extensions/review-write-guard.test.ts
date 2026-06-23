import { afterEach, describe, expect, it, vi } from "vitest"
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
		const guard = new OrchestratorWriteGuard()
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("blocks write during review phase", () => {
		const guard = new OrchestratorWriteGuard()
		const result = guard.checkToolCall("write")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("does not block read-only tools during review phase", () => {
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("read")).toBeUndefined()
		expect(guard.checkToolCall("bash")).toBeUndefined()
		expect(guard.checkToolCall("grep")).toBeUndefined()
	})

	it("resets when Agent is called", () => {
		const guard = new OrchestratorWriteGuard()
		guard.checkToolCall("Agent")
		mockPhase = "review"
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("blocks every edit attempt, not just the first", () => {
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("write")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})
})

describe("OrchestratorWriteGuard — build phase", () => {
	it("allows edits in build phase before any subagent returns", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("write")).toBeUndefined()
	})

	it("steers after threshold edits following a subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2 })
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})

	it("steers only once then allows edits until block threshold", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		guard.checkToolCall("edit")
		expect(guard.getState().buildSteered).toBe(true)
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("blocks after block threshold edits following a subagent return", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 4; i++) guard.checkToolCall("edit")
		const result = guard.checkToolCall("edit")
		expect(result).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("keeps blocking on every edit after block threshold", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2, buildPhaseBlockThreshold: 5 })
		guard.recordSubagentReturn()
		for (let i = 0; i < 5; i++) guard.checkToolCall("edit")
		expect(guard.checkToolCall("edit")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
		expect(guard.checkToolCall("write")).toEqual({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("resets when a new Agent is spawned", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		guard.checkToolCall("Agent")
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
		expect(guard.getState().buildWriteCount).toBe(0)
	})

	it("does not track subagent returns outside build phase", () => {
		mockPhase = "plan"
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
	})

	it("uses default threshold of 2", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard()
		guard.recordSubagentReturn()
		expect(guard.checkToolCall("edit")).toBeUndefined()
		expect(guard.checkToolCall("edit")).toEqual({ steer: expect.stringContaining("Delegation guard") })
	})
})

describe("OrchestratorWriteGuard — other phases", () => {
	it("does not block edits outside review phase", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("does not block edits in plan phase", () => {
		mockPhase = "plan"
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("does nothing when phase is undefined", () => {
		mockPhase = undefined
		const guard = new OrchestratorWriteGuard()
		expect(guard.checkToolCall("edit")).toBeUndefined()
	})

	it("resets build tracking when phase changes to non-build/review", () => {
		mockPhase = "build"
		const guard = new OrchestratorWriteGuard({ buildPhaseThreshold: 2 })
		guard.recordSubagentReturn()
		guard.checkToolCall("edit")
		mockPhase = "plan"
		guard.checkToolCall("edit")
		expect(guard.getState().subagentReturnedInBuild).toBe(false)
	})
})
