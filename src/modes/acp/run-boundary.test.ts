import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "vitest"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitRunEnd, emitRunStart, runEndOutcomeFromFlags } from "./run-boundary.js"

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

describe("run-boundary wire methods", () => {
	it("registers both boundary notifications in the ext-notification table", () => {
		// The canonical home for outbound ext-notification wire names: clients
		// and emitters alike reference AVAILABLE_EXT_NOTIFICATIONS, so an
		// unregistered method here means the notification cannot be gated on.
		expect(AVAILABLE_EXT_NOTIFICATIONS.run_start).toBe("_kimchi.dev/run_start")
		expect(AVAILABLE_EXT_NOTIFICATIONS.run_end).toBe("_kimchi.dev/run_end")
	})
})

describe("run-boundary emission", () => {
	it("run_start carries the v2-shaped running state and reason", () => {
		const { conn, sent } = fakeConn()
		emitRunStart(conn, "session-1", "background-task-complete")
		expect(sent).toEqual([
			{
				method: AVAILABLE_EXT_NOTIFICATIONS.run_start,
				params: { sessionId: "session-1", state: "running", reason: "background-task-complete" },
			},
		])
	})

	it("run_end carries the v2-shaped idle state and outcome", () => {
		const { conn, sent } = fakeConn()
		emitRunEnd(conn, "session-1", "end_turn")
		expect(sent).toEqual([
			{
				method: AVAILABLE_EXT_NOTIFICATIONS.run_end,
				params: { sessionId: "session-1", state: "idle", outcome: "end_turn" },
			},
		])
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
