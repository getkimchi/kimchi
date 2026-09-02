/**
 * Integration tests for the reviewWriteGuardExtension wiring.
 * Tests the event handler registration (session_start, tool_call, tool_result)
 * using a mock ExtensionAPI.
 */
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import reviewWriteGuardExtension, { STEER_MESSAGE_TYPE } from "./review-write-guard.js"

let mockPhase: string | undefined = "review"

vi.mock("./tags.js", () => ({
	getCurrentPhase: () => mockPhase,
}))

function createMockPI(options?: Parameters<typeof reviewWriteGuardExtension>[1]) {
	const pi = createExtensionApi()
	reviewWriteGuardExtension(pi.api, options)
	const harness: typeof pi & { blockResult: ToolCallEventResult | undefined } = {
		...pi,
		blockResult: undefined,
	}
	return harness
}

function emit(
	pi: ReturnType<typeof createMockPI>,
	event: string,
	payload: Record<string, unknown> = {},
	ctx = createContext(),
) {
	for (const h of pi.getHandlers<Record<string, unknown>, ToolCallEventResult>(event)) {
		const result = h(payload, ctx)
		if (result instanceof Promise) throw new Error(`Expected synchronous ${event} handler`)
		if (result?.block) {
			pi.blockResult = result
		}
	}
}

describe("reviewWriteGuardExtension wiring", () => {
	it("registers session_start handler that resets guard state", () => {
		const pi = createMockPI()

		// Exhaust the review trivial-fix allowance and trigger the steer.
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		// Move to build phase and record a subagent return
		mockPhase = "build"
		emit(pi, "tool_result", { toolName: "Agent" })

		// session_start should reset — emit it
		emit(pi, "session_start", {})

		// After reset, the review trivial-fix allowance is fresh again and the
		// steer fires anew once the fresh allowance is exhausted.
		mockPhase = "review"
		pi.sendMessage.mockClear()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.blockResult).toBeUndefined()
	})

	it("tool_call for Agent in review phase does NOT block", () => {
		const pi = createMockPI()
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "Agent" })
		expect(pi.blockResult).toBeUndefined()
	})

	it("tool_call for edit during review phase allows the first edit (trivial fix exception)", () => {
		const pi = createMockPI()
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.blockResult).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("tool_call for edit during review phase steers after two edits, but never blocks", () => {
		const pi = createMockPI()
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		// Further edits are not blocked and do not steer again.
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.blockResult).toBeUndefined()
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("tool_call for write during review phase steers after two writes", () => {
		const pi = createMockPI()
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "write" })
		emit(pi, "tool_call", { toolName: "write" })
		expect(pi.blockResult).toBeUndefined()
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not renew the review allowance when an Agent returns", () => {
		const pi = createMockPI()
		mockPhase = "review"
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_result", { toolName: "Agent" })

		emit(pi, "tool_call", { toolName: "edit" })

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: [expect.objectContaining({ text: expect.stringContaining("up to two small edit/write calls") })],
			}),
			{ deliverAs: "steer" },
		)
	})

	it("tool_result for Agent in build phase records subagent return", () => {
		const pi = createMockPI()
		mockPhase = "build"
		emit(pi, "tool_result", { toolName: "Agent" })

		// Now edit twice — should steer after threshold
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.blockResult).toBeUndefined()
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
		const pi = createMockPI({ buildPhaseThreshold: 2, buildPhaseBlockThreshold: 4 })
		mockPhase = "build"

		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" }) // 1
		emit(pi, "tool_call", { toolName: "edit" }) // 2 — steer
		emit(pi, "tool_call", { toolName: "edit" }) // 3
		expect(pi.blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }) // 4 — block
		expect(pi.blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("steer message is delivered via pi.sendMessage in build phase after threshold", () => {
		const pi = createMockPI({ buildPhaseThreshold: 2 })
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
		const pi = createMockPI({ buildPhaseThreshold: 2 })
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
		const pi = createMockPI({
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
		expect(pi.blockResult).toBeUndefined()

		// 4th edit triggers steer (not block).
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi.blockResult).toBeUndefined()
	})

	it("uses triage thresholds when agentOutcome is unknown", () => {
		const pi = createMockPI({
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
		expect(pi.blockResult).toBeUndefined()

		// 4th edit crosses the triage steer threshold.
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi.blockResult).toBeUndefined()
	})

	it("uses normal thresholds when agentOutcome indicates success", () => {
		const pi = createMockPI({ buildPhaseThreshold: 2 })
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
		const pi = createMockPI({ buildPhaseThreshold: 2 })
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
		const pi = createMockPI({ buildPhaseThreshold: 2 })
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
		// The first review edit is silent; the second steers on a fresh guard.
		pi.sendMessage.mockClear()
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.blockResult).toBeUndefined()
	})
})
