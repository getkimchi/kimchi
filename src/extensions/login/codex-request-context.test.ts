import { describe, expect, it } from "vitest"
import {
	beginCodexCompaction,
	codexRequestMetadata,
	countCompactions,
	endCodexCompaction,
	resetCodexSession,
	startCodexTurn,
} from "./codex-request-context.js"

describe("codex request context", () => {
	it("starts at window 0 with a v7 turn id, kind turn", () => {
		const m = codexRequestMetadata("s1")
		expect(m).toMatchObject({
			sessionId: "s1",
			threadId: "s1",
			requestKind: "turn",
			windowId: "s1:0",
			windowNumber: 0,
		})
		expect(m.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
		resetCodexSession("s1")
	})

	it("keeps the turn id until the next turn starts", () => {
		const a = codexRequestMetadata("s1").turnId
		expect(codexRequestMetadata("s1").turnId).toBe(a)
		startCodexTurn("s1", 0)
		const b = codexRequestMetadata("s1").turnId
		expect(b).not.toBe(a)
		expect(b > a).toBe(true)
		resetCodexSession("s1")
	})

	it("a turn on a resumed session uses its window number", () => {
		startCodexTurn("s1", 2)
		expect(codexRequestMetadata("s1").windowId).toBe("s1:2")
		resetCodexSession("s1")
	})

	it("marks requests during a compaction and moves to the next window after it", () => {
		startCodexTurn("s1", 0)
		beginCodexCompaction("s1")
		expect(codexRequestMetadata("s1")).toMatchObject({ requestKind: "compaction", windowId: "s1:0" })
		endCodexCompaction("s1", 1)
		expect(codexRequestMetadata("s1")).toMatchObject({ requestKind: "turn", windowId: "s1:1" })
		resetCodexSession("s1")
	})

	it("a failed compaction keeps the window and clears the kind", () => {
		startCodexTurn("s1", 0)
		beginCodexCompaction("s1")
		endCodexCompaction("s1", 0)
		expect(codexRequestMetadata("s1")).toMatchObject({ requestKind: "turn", windowNumber: 0 })
		resetCodexSession("s1")
	})

	it("a new turn clears a compaction flag left behind", () => {
		beginCodexCompaction("s1")
		startCodexTurn("s1", 0)
		expect(codexRequestMetadata("s1").requestKind).toBe("turn")
		resetCodexSession("s1")
	})

	it("sessions are independent", () => {
		beginCodexCompaction("s1")
		const s2 = codexRequestMetadata("s2")
		expect(s2).toMatchObject({ requestKind: "turn", windowNumber: 0 })
		expect(s2.turnId).not.toBe(codexRequestMetadata("s1").turnId)
		resetCodexSession("s1")
		resetCodexSession("s2")
	})

	it("reset forgets the session", () => {
		startCodexTurn("s1", 3)
		resetCodexSession("s1")
		expect(codexRequestMetadata("s1").windowNumber).toBe(0)
		resetCodexSession("s1")
	})

	it("counts compaction entries only", () => {
		expect(countCompactions([{ type: "message" }, { type: "compaction" }, { type: "compaction" }])).toBe(2)
	})
})
