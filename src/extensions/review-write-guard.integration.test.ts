/**
 * Integration tests for the reviewWriteGuardExtension wiring.
 * Tests the event handler registration (session_start, agent_start, tool_call, tool_result)
 * using a mock ExtensionAPI.
 */
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { setMultiModelEnabled } from "./multi-model.js"
import reviewWriteGuardExtension, { STEER_MESSAGE_TYPE } from "./review-write-guard.js"

/**
 * Mechanics harness: pins the delegation policy on so these tests exercise the
 * guard's counting/threshold behaviour rather than the policy that gates it.
 * Policy itself is covered by `createRealPolicyPI` below.
 */
function createMockPI(options?: Parameters<typeof reviewWriteGuardExtension>[1]) {
	const pi = createExtensionApi()
	reviewWriteGuardExtension(pi.api, { isDelegationRequired: () => true, ...options })
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

		// Record a subagent return and exhaust the steer threshold.
		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		// session_start should reset — emit it
		emit(pi, "session_start", {})

		// After reset, the guard is disarmed: edits pass freely until a new subagent return.
		pi.sendMessage.mockClear()
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
	})

	it("agent_start resets counters so edits in a later user prompt are not blocked", () => {
		const pi = createMockPI({ steerThreshold: 2, blockThreshold: 5 })

		// Arm the guard and hit the steer threshold.
		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		// A new user prompt (agent_start) resets the guard — no hard block.
		emit(pi, "agent_start", {})
		pi.sendMessage.mockClear()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
	})

	it("tool_call for Agent does NOT block", () => {
		const pi = createMockPI()
		emit(pi, "tool_call", { toolName: "Agent" })
		expect(pi.blockResult).toBeUndefined()
	})

	it("tool_call for edit before any subagent return allows edits freely", () => {
		const pi = createMockPI()
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.blockResult).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("tool_call for edit steers after threshold following a subagent return, but never blocks before block threshold", () => {
		const pi = createMockPI()
		emit(pi, "tool_result", { toolName: "Agent" })
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

	it("tool_result for Agent arms the guard", () => {
		const pi = createMockPI()
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

	it("state survives multiple edits without a new subagent return", () => {
		const pi = createMockPI()

		// Record subagent return — armed = true
		emit(pi, "tool_result", { toolName: "Agent" })

		// Multiple edits — state persists, steer fires after threshold
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		// Further edits — steered = true, so no more steers (until block threshold)
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("blocks after block threshold edits following a subagent return", () => {
		const pi = createMockPI({ steerThreshold: 2, blockThreshold: 4 })

		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" }) // 1
		emit(pi, "tool_call", { toolName: "edit" }) // 2 — steer
		emit(pi, "tool_call", { toolName: "edit" }) // 3
		expect(pi.blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }) // 4 — block
		expect(pi.blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })
	})

	it("steer message is delivered via pi.sendMessage after threshold", () => {
		const pi = createMockPI({ steerThreshold: 2 })

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

	it("keeps state isolated between sessions", () => {
		const pi = createMockPI({ steerThreshold: 2 })

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
			steerThreshold: 2,
			triageSteerThreshold: 4,
			blockThreshold: 5,
			triageBlockThreshold: 8,
		})

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
			steerThreshold: 2,
			triageSteerThreshold: 4,
			blockThreshold: 5,
			triageBlockThreshold: 8,
		})

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
		const pi = createMockPI({ steerThreshold: 2 })

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
		const pi = createMockPI({ steerThreshold: 2 })

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

	it("guard disarms at user-prompt boundary and only throttles within the armed turn", () => {
		// D3 negative test (§7 R1): proves three things in one lifecycle:
		//  (a) after an Agent return, implementation calls under the armed
		//      threshold are NOT steered or hard-blocked;
		//  (b) an agent_start event resets the counter — the same calls in the
		//      NEXT user prompt are again allowed (no carryover hard-block);
		//  (c) exceeding the threshold within the same armed turn DOES produce
		//      steering then blocking.
		const pi = createMockPI({ steerThreshold: 2, blockThreshold: 4 })

		// ── (a) subagent return arms the guard; under-threshold edits pass freely ──
		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" }) // 1 — under steer threshold
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()

		// ── (c) exceeding the threshold within the SAME armed turn steers then blocks ──
		emit(pi, "tool_call", { toolName: "edit" }) // 2 — steer fires
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi.blockResult).toBeUndefined() // steer is not a block

		emit(pi, "tool_call", { toolName: "edit" }) // 3 — past steer, under block
		expect(pi.blockResult).toBeUndefined()

		emit(pi, "tool_call", { toolName: "edit" }) // 4 — block threshold
		expect(pi.blockResult).toMatchObject({ block: true, reason: expect.stringContaining("BLOCKED") })

		// ── (b) agent_start resets — same calls in the NEXT user prompt are allowed again ──
		pi.blockResult = undefined
		pi.sendMessage.mockClear()
		emit(pi, "agent_start", {})

		// The guard is now disarmed; the same edit calls that were blocked
		// moments ago pass without steering or blocking.
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
	})

	it("steers on the 2nd edit after a delegation even when turn_start fires between the Agent result and the edits (real production event order)", () => {
		// Regression for the turn_start-vs-agent_start reset bug (review issues 1+2).
		// In production, runAgentLoop emits agent_start once per user prompt but
		// re-emits turn_start at the start of EVERY inner-loop iteration
		// (agent-loop.js:88-92: `if (!firstTurn) emit turn_start`).
		// The real delegation event order is therefore:
		//   turn_start -> tool_result(Agent) [arms guard] -> turn_start [next iter]
		//   -> tool_call(edit) x2 [expect STEER on the 2nd].
		// With the reset wired to turn_start, the second turn_start disarms the
		// guard before any edit is checked, so checkToolCall returns undefined
		// and the steer is unreachable. The reset must be on agent_start
		// (per-user-prompt boundary) so the arm survives across iterations.
		const pi = createMockPI()

		// ── iteration 1: assistant message with an Agent tool call ──
		emit(pi, "turn_start", {})
		emit(pi, "tool_result", { toolName: "Agent" }) // arms the guard

		// ── iteration 2: turn_start re-emitted, THEN the model edits ──
		emit(pi, "turn_start", {})
		expect(pi.sendMessage).not.toHaveBeenCalled()
		emit(pi, "tool_call", { toolName: "edit" }) // 1st edit — under threshold
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }) // 2nd edit — should STEER
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: STEER_MESSAGE_TYPE }), {
			deliverAs: "steer",
		})
		expect(pi.blockResult).toBeUndefined()
	})

	it("evicts the session guard from the map on session_shutdown", () => {
		const pi = createMockPI({ steerThreshold: 2 })

		const ctx = createContext({ sessionManager: { getSessionId: () => "session-evict" } })

		// Populate the guardMap by recording a subagent return.
		emit(pi, "tool_result", { toolName: "Agent" }, ctx)

		// First edit would normally pass under the steer threshold of 2.
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).not.toHaveBeenCalled()

		// Fire session_shutdown for the same session — guard should be evicted.
		emit(pi, "session_shutdown", {}, ctx)

		// A fresh session_start + subagent return on the same session should behave like a
		// new guard (armed is true again, no leftover state).
		emit(pi, "session_start", {}, ctx)
		emit(pi, "tool_result", { toolName: "Agent" }, ctx)
		pi.sendMessage.mockClear()
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
		emit(pi, "tool_call", { toolName: "edit" }, ctx)
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.blockResult).toBeUndefined()
	})
})

describe("reviewWriteGuardExtension delegation-mode policy", () => {
	it("does not steer or block when delegation is not required (relaxed-mode ferment)", () => {
		const pi = createMockPI({ isDelegationRequired: () => false })
		emit(pi, "tool_result", { toolName: "Agent" })

		// Relaxed ferment instructs the orchestrator to execute steps directly.
		// Well past both the steer (2) and block (5) thresholds.
		for (let i = 0; i < 8; i++) {
			emit(pi, "tool_call", { toolName: "edit" })
		}

		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
	})

	it("still steers and blocks when delegation is required (strict-mode ferment or no ferment)", () => {
		const pi = createMockPI({ isDelegationRequired: () => true })
		emit(pi, "tool_result", { toolName: "Agent" })

		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)

		for (let i = 0; i < 3; i++) {
			emit(pi, "tool_call", { toolName: "edit" })
		}
		expect(pi.blockResult?.block).toBe(true)
	})

	it("disarms when a ferment activates mid-turn after the guard was already armed", () => {
		let required = true
		const pi = createMockPI({ isDelegationRequired: () => required })

		// Armed under a delegation-required policy.
		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" })

		// A relaxed-mode ferment activates; the next Agent return must reset,
		// not re-arm, so the orchestrator is not left throttled.
		required = false
		emit(pi, "tool_result", { toolName: "Agent" })

		for (let i = 0; i < 8; i++) {
			emit(pi, "tool_call", { toolName: "edit" })
		}
		expect(pi.blockResult).toBeUndefined()
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})
})

/** Policy harness: no seam, so the real `delegationRequired` predicate runs. */
function createRealPolicyPI() {
	const pi = createExtensionApi()
	reviewWriteGuardExtension(pi.api)
	const harness: typeof pi & { blockResult: ToolCallEventResult | undefined } = { ...pi, blockResult: undefined }
	return harness
}

describe("reviewWriteGuardExtension default delegation policy (no injected seam)", () => {
	afterEach(() => {
		setMultiModelEnabled("test-session", false)
	})

	it("does not arm in a single-model session (the prompt tells it not to delegate)", () => {
		setMultiModelEnabled("test-session", false)
		const pi = createRealPolicyPI()
		emit(pi, "tool_result", { toolName: "Agent" })
		for (let i = 0; i < 8; i++) {
			emit(pi, "tool_call", { toolName: "edit" })
		}
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.blockResult).toBeUndefined()
	})

	it("arms in a multi-model session, where delegation is the default", () => {
		setMultiModelEnabled("test-session", true)
		const pi = createRealPolicyPI()
		emit(pi, "tool_result", { toolName: "Agent" })
		emit(pi, "tool_call", { toolName: "edit" })
		emit(pi, "tool_call", { toolName: "edit" })
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not arm for a relaxed-mode ferment, which is single-model by definition", () => {
		process.env.KIMCHI_ACTIVE_FERMENT = "f-relaxed"
		setMultiModelEnabled("test-session", false)
		try {
			const pi = createRealPolicyPI()
			emit(pi, "tool_result", { toolName: "Agent" })
			for (let i = 0; i < 8; i++) {
				emit(pi, "tool_call", { toolName: "edit" })
			}
			expect(pi.sendMessage).not.toHaveBeenCalled()
			expect(pi.blockResult).toBeUndefined()
		} finally {
			delete process.env.KIMCHI_ACTIVE_FERMENT
		}
	})
})
