/**
 * Integration tests for the reviewWriteGuardExtension wiring.
 * Tests the event handler registration (session_start, tool_call, tool_result)
 * using a mock ExtensionAPI.
 */
import { describe, expect, it, vi } from "vitest"
import { STEER_MESSAGE_TYPE } from "./review-write-guard.js"
import reviewWriteGuardExtension from "./review-write-guard.js"

let mockPhase: string | undefined = "review"

vi.mock("./tags.js", () => ({
	getCurrentPhase: () => mockPhase,
}))

type BlockResult = { block: true; reason: string }

interface MockExtensionAPI {
	handlers: Record<string, Array<(event: { toolName?: string; result?: unknown }) => unknown>>
	on: (event: string, handler: (event: { toolName?: string; result?: unknown }) => unknown) => void
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

function emit(pi: MockExtensionAPI, event: string, payload: { toolName?: string; result?: unknown } = {}) {
	const handlers = pi.handlers[event] ?? []
	for (const h of handlers) {
		const result = h(payload) as BlockResult | undefined
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
})
