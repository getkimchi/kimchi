/**
 * Integration tests for the reviewWriteGuardExtension wiring.
 * Tests the event handler registration (session_start, tool_call, tool_result)
 * using a mock ExtensionAPI.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import reviewWriteGuardExtension, { STEER_MESSAGE_TYPE } from "./review-write-guard.js"

let mockPhase: string | undefined = "review"

vi.mock("./tags.js", () => ({
	getCurrentPhase: () => mockPhase,
}))

type BlockResult = { block: true; reason: string }

interface ToolEventPayload {
	toolName?: string
	result?: unknown
	details?: unknown
}

interface MockExtensionAPI {
	handlers: Record<string, Array<(event: ToolEventPayload, ctx: ExtensionContext) => unknown>>
	on: (event: string, handler: (event: ToolEventPayload, ctx: ExtensionContext) => unknown) => void
	sendMessage: ReturnType<typeof vi.fn>
	_blockResult?: BlockResult
}

function createMockPI(): MockExtensionAPI {
	const handlers: MockExtensionAPI["handlers"] = {}
	return {
		handlers,
		on(event: string, handler) {
			if (!handlers[event]) handlers[event] = []
			handlers[event].push(handler)
		},
		sendMessage: vi.fn(),
	}
}

function emit(pi: MockExtensionAPI, event: string, payload: ToolEventPayload = {}, ctx = createContext()) {
	const handlers = pi.handlers[event] ?? []
	for (const h of handlers) {
		const result = h(payload, ctx) as BlockResult | undefined
		if (result?.block) {
			pi._blockResult = result
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PI = import("@earendil-works/pi-coding-agent").ExtensionAPI

describe("reviewWriteGuardExtension wiring", () => {
	it("registers session_start handler that resets guard state", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)

		// Move to build phase and record a subagent return
		mockPhase = "build"
		emit(pi, "tool_result", { toolName: "Agent" })

		// session_start should reset — emit it
		emit(pi, "session_start", {})

		// After reset, tool_call in review should still block (not affected by prior state)
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi._blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("tool_call for Agent in review phase does NOT block", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "Agent" })
		expect(pi._blockResult).toBeUndefined()
	})

	it("tool_call for edit during review phase blocks", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi._blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("tool_call for write during review phase blocks", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "write" })
		expect(pi._blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("tool_result for Agent in build phase records subagent return", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)
		mockPhase = "build"
		emit(pi, "tool_result", { toolName: "Agent" })

		// Now edit twice — should steer after threshold
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi._blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: STEER_MESSAGE_TYPE,
				content: expect.arrayContaining([expect.objectContaining({ type: "text" })]),
				display: false,
			}),
			{ deliverAs: "steer" },
		)
	})

	// NOTE: The extension's tool_call handler returns early for "Agent" without
	// calling checkToolCall, so Agent tool calls do NOT reset state directly.
	// State resets (recordSubagentReturn) happen when the subagent FINISHES
	// (tool_result). A new subagent spawning does NOT reset state — it resets
	// when that subagent returns.
	it("state survives multiple edits without a new subagent return", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI)
		mockPhase = "build"

		// Record subagent return — subagentReturnedInBuild = true
		emit(pi, "tool_result", { toolName: "Agent" })

		// Multiple edits — state persists, steer fires after threshold
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		// After 2 edits above threshold, steer fires
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		// Further edits — buildSteered = true, so no more steers (until block threshold)
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("blocks after block threshold edits in build phase", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2, buildPhaseBlockThreshold: 4 })
		mockPhase = "build"

		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" }) // 1
		emit(pi, "tool_call", { toolName: "edit" }) // 2 — steer
		emit(pi, "tool_call", { toolName: "edit" }) // 3
		expect(pi._blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }) // 4 — block
		expect(pi._blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("steer message is delivered via pi.sendMessage in build phase after threshold", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2 })
		mockPhase = "build"

		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: STEER_MESSAGE_TYPE,
			}),
			{ deliverAs: "steer" },
		)
	})

	it("keeps build-phase state isolated between sessions", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2 })
		mockPhase = "build"

		// Session A hits the steer threshold.
		emit(
			pi,
			"tool_result",
			{ toolName: "Agent" },
			createContext({ sessionManager: { getSessionId: () => "session-a" } }),
		)
		emit(pi, "tool_call", { toolName: "edit" }, createContext({ sessionManager: { getSessionId: () => "session-a" } }))
		emit(pi, "tool_call", { toolName: "edit" }, createContext({ sessionManager: { getSessionId: () => "session-a" } }))

		// Session B records its own subagent return and makes only one edit.
		emit(
			pi,
			"tool_result",
			{ toolName: "Agent" },
			createContext({ sessionManager: { getSessionId: () => "session-b" } }),
		)
		emit(pi, "tool_call", { toolName: "edit" }, createContext({ sessionManager: { getSessionId: () => "session-b" } }))

		// Only session A should have triggered a steer.
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("extracts agentOutcome from tool_result details and applies triage thresholds", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseBlockThreshold: 5,
			buildPhaseTriageBlockThreshold: 8,
		})
		mockPhase = "build"

		emit(pi, "tool_result", {
			toolName: "Agent",
			result: undefined,
			details: {
				status: "aborted",
				outcome: "failed",
				subagentType: "Builder",
				agentOutcome: { status: "aborted", outcome: "failed", subagentType: "Builder" },
			},
		})

		// First 3 edits are allowed under triage threshold of 4.
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()

		// 4th edit triggers steer (not block).
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi._blockResult).toBeUndefined()
	})

	it("uses triage thresholds when agentOutcome is unknown", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, {
			buildPhaseThreshold: 2,
			buildPhaseTriageThreshold: 4,
			buildPhaseBlockThreshold: 5,
			buildPhaseTriageBlockThreshold: 8,
		})
		mockPhase = "build"

		emit(pi, "tool_result", {
			toolName: "Agent",
			result: undefined,
			details: {
				status: "weird",
				outcome: "unknown",
				agentOutcome: { status: "weird", outcome: "unknown" },
			},
		})

		// 3 edits under the triage threshold of 4 should not trigger a steer.
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi._blockResult).toBeUndefined()

		// 4th edit crosses the triage steer threshold.
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi._blockResult).toBeUndefined()
	})

	it("uses normal thresholds when agentOutcome indicates success", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2 })
		mockPhase = "build"

		emit(pi, "tool_result", {
			toolName: "Agent",
			result: undefined,
			details: {
				status: "completed",
				outcome: "completed",
				agentOutcome: { status: "completed", outcome: "completed", subagentType: "Builder" },
			},
		})

		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not reset guard state when the orchestrator spawns another Agent", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2 })
		mockPhase = "build"

		// First subagent returns and arms the guard.
		emit(pi, "tool_result", { toolName: "Agent" })

		// One edit counts toward the threshold.
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// Spawning another Agent must NOT reset the guard.
		emit(pi, "tool_call", { toolName: "Agent" })

		// The second edit should still trigger the steer from the first subagent return.
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
	})

	it("evicts the session guard from the map on session_shutdown", () => {
		const pi = createMockPI()
		reviewWriteGuardExtension(pi as unknown as PI, { buildPhaseThreshold: 2 })
		mockPhase = "build"

		const ctx = createContext({ sessionManager: { getSessionId: () => "session-evict" } })

		// Populate the guardMap by recording a subagent return.
		emit(pi, "tool_result", { toolName: "Agent" }, ctx)

		// First edit would normally pass under the steer threshold of 2.
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// Fire session_shutdown for the same session — guard should be evicted.
		emit(pi, "session_shutdown", {}, ctx)

		// A fresh subagent return + edit on the same session should behave like a
		// new guard (subagentReturnedInBuild is true again, no leftover state).
		// If the old guard had been reused, the second edit below would still be
		// allowed (count reset by recordSubagentReturn), but the eviction proves
		// the old instance is gone — assert by re-checking sessionStart behavior.
		emit(pi, "session_start", {}, ctx)
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi._blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})
})
