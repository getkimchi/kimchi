import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	emitRunEnd,
	emitRunStart,
	RUN_END_METHOD,
	RUN_START_METHOD,
	registerUnsolicitedRunReason,
	runEndOutcomeFromFlags,
	takePendingRunReason,
} from "./run-boundary.js"

function fakeConn(): { conn: AgentSideConnection; sent: Array<{ method: string; params: Record<string, unknown> }> } {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = []
	const conn = {
		extNotification: (method: string, params: Record<string, unknown>) => {
			sent.push({ method, params })
			return Promise.resolve()
		},
	} as unknown as AgentSideConnection
	return { conn, sent }
}

describe("run-boundary reason registry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		// Clear any leftover from an earlier test in the same process.
		takePendingRunReason()
	})

	afterEach(() => {
		takePendingRunReason()
		vi.useRealTimers()
	})

	it("returns the registered reason exactly once, then falls back", () => {
		registerUnsolicitedRunReason("background-task-complete")
		expect(takePendingRunReason()).toBe("background-task-complete")
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("falls back to agent-initiated when nothing was registered", () => {
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("discards a reason older than the TTL (stale suppressed wake)", () => {
		registerUnsolicitedRunReason("background-task-complete")
		vi.advanceTimersByTime(6_000)
		expect(takePendingRunReason()).toBe("agent-initiated")
	})

	it("keeps a reason inside the TTL", () => {
		registerUnsolicitedRunReason("background-task-complete")
		vi.advanceTimersByTime(4_999)
		expect(takePendingRunReason()).toBe("background-task-complete")
	})
})

describe("run-boundary emission", () => {
	it("run_start carries the v2-shaped running state and reason", () => {
		const { conn, sent } = fakeConn()
		emitRunStart(conn, "session-1", "background-task-complete")
		expect(sent).toEqual([
			{
				method: RUN_START_METHOD,
				params: { sessionId: "session-1", state: "running", reason: "background-task-complete" },
			},
		])
		expect(sent[0].method).toBe("_kimchi.dev/run_start")
	})

	it("run_end carries the v2-shaped idle state and outcome", () => {
		const { conn, sent } = fakeConn()
		emitRunEnd(conn, "session-1", "end_turn")
		expect(sent).toEqual([
			{ method: RUN_END_METHOD, params: { sessionId: "session-1", state: "idle", outcome: "end_turn" } },
		])
		expect(sent[0].method).toBe("_kimchi.dev/run_end")
	})
})

describe("runEndOutcomeFromFlags", () => {
	it("precedence: cancelled > error > refusal > end_turn", () => {
		const base = { cancelled: false, lastAssistantError: undefined, refused: false }
		expect(runEndOutcomeFromFlags(base)).toBe("end_turn")
		expect(runEndOutcomeFromFlags({ ...base, refused: true })).toBe("refusal")
		expect(runEndOutcomeFromFlags({ ...base, refused: true, lastAssistantError: "boom" })).toBe("error")
		expect(runEndOutcomeFromFlags({ cancelled: true, lastAssistantError: "boom", refused: true })).toBe("cancelled")
	})

	it("treats missing flags as a clean end_turn", () => {
		expect(runEndOutcomeFromFlags({})).toBe("end_turn")
	})
})
