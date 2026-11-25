import type { AgentContext } from "@agentclientprotocol/sdk/unstable"
import { describe, expect, it } from "vitest"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitRunEnd, emitRunStart, runStopReasonFromFlags } from "./run-boundary.js"

function fakeConn(): { conn: AgentContext; sent: Array<{ method: string; params: Record<string, unknown> }> } {
	const sent: Array<{ method: string; params: Record<string, unknown> }> = []
	const conn = {
		notify: (method: string, params: Record<string, unknown>) => {
			sent.push({ method, params })
			return Promise.resolve()
		},
	} as unknown as AgentContext
	return { conn, sent }
}

describe("run-boundary emission", () => {
	it("background_run_start carries the v2-shaped running state and reason", () => {
		const { conn, sent } = fakeConn()
		emitRunStart(conn, "session-1", "background-task-complete")
		expect(sent).toEqual([
			{
				method: AVAILABLE_EXT_NOTIFICATIONS.background_run_start,
				params: { sessionId: "session-1", state: "running", reason: "background-task-complete" },
			},
		])
	})

	it("background_run_end carries the idle state and a v1-named stopReason", () => {
		const { conn, sent } = fakeConn()
		emitRunEnd(conn, "session-1", "end_turn")
		expect(sent).toEqual([
			{
				method: AVAILABLE_EXT_NOTIFICATIONS.background_run_end,
				params: { sessionId: "session-1", state: "idle", stopReason: "end_turn" },
			},
		])
	})
})

describe("runStopReasonFromFlags", () => {
	it("precedence: cancelled > error > refusal > end_turn", () => {
		const base = { cancelled: false, lastAssistantError: undefined, refused: false }
		expect(runStopReasonFromFlags(base)).toBe("end_turn")
		expect(runStopReasonFromFlags({ ...base, refused: true })).toBe("refusal")
		expect(runStopReasonFromFlags({ ...base, refused: true, lastAssistantError: "boom" })).toBe("error")
		expect(runStopReasonFromFlags({ cancelled: true, lastAssistantError: "boom", refused: true })).toBe("cancelled")
	})

	it("treats missing flags as a clean end_turn", () => {
		expect(runStopReasonFromFlags({})).toBe("end_turn")
	})
})
