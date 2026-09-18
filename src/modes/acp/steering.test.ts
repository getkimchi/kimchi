import type { AgentSideConnection, ContentChunk, SessionUpdate } from "@agentclientprotocol/sdk"
import { describe, expect, it, vi } from "vitest"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { notifyDroppedQueue, reconcileQueue } from "./steering.js"

function chunkText(u: SessionUpdate): string {
	if (u.sessionUpdate !== "user_message_chunk") throw new Error(`not a user chunk: ${u.sessionUpdate}`)
	const content = u.content
	if (content.type !== "text") throw new Error(`not a text chunk: ${content.type}`)
	return content.text
}

function chunkId(u: SessionUpdate): string | null | undefined {
	return (u as ContentChunk).messageId
}

describe("reconcileQueue", () => {
	it("consumes nothing when the snapshot is unchanged", () => {
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "B"], ["A", "B"])
		expect(sessionUpdates).toEqual([])
		expect(previousQueue).toEqual(["A", "B"])
	})

	it("consumes front-removed messages (pure left shift)", () => {
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "B", "C"], ["C"])
		expect(sessionUpdates.map(chunkText)).toEqual(["A", "B"])
		expect(previousQueue).toEqual(["C"])
	})

	it("consumes nothing when the queue only grew (enqueue)", () => {
		// Regression for the negative-delta slice bug: an enqueue-only snapshot
		// must not fabricate consumed messages via slice(0, negative).
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "B"], ["A", "B", "C"])
		expect(sessionUpdates).toEqual([])
		expect(previousQueue).toEqual(["A", "B", "C"])
	})

	it("handles enqueue into an empty queue", () => {
		const { sessionUpdates } = reconcileQueue([], ["A"])
		expect(sessionUpdates).toEqual([])
	})

	it("consumes everything when the queue drains to empty", () => {
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "B"], [])
		expect(sessionUpdates).toHaveLength(2)
		expect(previousQueue).toEqual([])
	})

	it("consumes exactly one occurrence of duplicated text", () => {
		const { sessionUpdates } = reconcileQueue(["A", "A"], ["A"])
		expect(sessionUpdates).toHaveLength(1)
		expect(chunkText(sessionUpdates[0])).toBe("A")
	})

	it("consumes the front duplicate, not both", () => {
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "A", "B"], ["A", "B"])
		expect(sessionUpdates).toHaveLength(1)
		expect(previousQueue).toEqual(["A", "B"])
	})

	it("falls back to multiset diff when the queue was reordered", () => {
		// [A, B] -> [B]: not a pure left shift (B !== previous[1+?] in order),
		// but B is still pending, so A was consumed.
		const { previousQueue, sessionUpdates } = reconcileQueue(["A", "B"], ["B"])
		// Note: [A,B] -> [B] IS a left shift; use a true reorder instead.
		expect(sessionUpdates).toHaveLength(1)
		expect(chunkText(sessionUpdates[0])).toBe("A")
		expect(previousQueue).toEqual(["B"])

		const reorder = reconcileQueue(["A", "B", "C"], ["C", "B"])
		expect(reorder.sessionUpdates.map(chunkText)).toEqual(["A"])
		expect(reorder.previousQueue).toEqual(["C", "B"])
	})

	it("multiset fallback tolerates remove-and-requeue of identical text", () => {
		// If "A" is removed and a new "A" enqueued in the same snapshot, the
		// multiset diff cannot distinguish it from no change — nothing echoes.
		// This documents the accepted under-counting, not a bug: pi's own
		// tracking is text-keyed the same way.
		const { sessionUpdates } = reconcileQueue(["A"], ["A"])
		expect(sessionUpdates).toEqual([])
	})

	it("echoes every consumed message as a user_message_chunk with a fresh messageId", () => {
		const { sessionUpdates } = reconcileQueue(["A", "B"], [])
		expect(sessionUpdates).toHaveLength(2)
		for (const u of sessionUpdates) {
			expect(u.sessionUpdate).toBe("user_message_chunk")
			expect(chunkId(u)).toMatch(/^[0-9a-f-]{36}$/)
		}
		expect(chunkId(sessionUpdates[0])).not.toBe(chunkId(sessionUpdates[1]))
	})

	it("does not mutate the previous snapshot and copies the next one", () => {
		const prev = ["A", "B"]
		const next = ["A", "B"]
		reconcileQueue(prev, next)
		expect(prev).toEqual(["A", "B"])
		const { previousQueue } = reconcileQueue(prev, next)
		expect(previousQueue).not.toBe(next)
		next.push("C")
		expect(previousQueue).toEqual(["A", "B"])
	})
})

describe("notifyDroppedQueue", () => {
	const conn = () => {
		const extNotification = vi.fn(async (_method: string, _params: unknown) => {})
		return { extNotification, asConn: { extNotification } as unknown as AgentSideConnection }
	}

	it("sends nothing when both queues are empty", () => {
		const { extNotification, asConn } = conn()
		notifyDroppedQueue(asConn, "sess-1", { steering: [], followUp: [] }, "cancelled")
		expect(extNotification).not.toHaveBeenCalled()
	})

	it("sends the dropped steering messages with the given reason", async () => {
		const { extNotification, asConn } = conn()
		notifyDroppedQueue(asConn, "sess-1", { steering: ["steer one"], followUp: [] }, "cancelled")
		expect(extNotification).toHaveBeenCalledTimes(1)
		expect(extNotification).toHaveBeenCalledWith(AVAILABLE_EXT_NOTIFICATIONS.queue_dropped, {
			sessionId: "sess-1",
			reason: "cancelled",
			steering: ["steer one"],
			followUp: [],
		})
	})

	it("passes the dropped-queue arrays through by reference", () => {
		// Callers hand over ownership of the drained arrays (clearQueue()
		// returns fresh copies) — no defensive copy, by contract.
		const { extNotification, asConn } = conn()
		const steering = ["steer"]
		const followUp = ["fu"]
		notifyDroppedQueue(asConn, "sess-1", { steering, followUp }, "shutdown")
		const params = extNotification.mock.calls[0]?.[1] as { steering: string[]; followUp: string[] }
		expect(params.steering).toBe(steering)
		expect(params.followUp).toBe(followUp)
	})

	it("swallows transport errors instead of rejecting (fire-and-forget)", async () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
		const { asConn } = {
			asConn: {
				extNotification: async () => {
					throw new Error("socket closed")
				},
			} as unknown as AgentSideConnection,
		}
		notifyDroppedQueue(asConn, "sess-1", { steering: ["s"], followUp: [] }, "shutdown")
		// Let the rejection propagate through the .catch handler.
		await Promise.resolve()
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("queue_dropped notification failed"))
		stderrSpy.mockRestore()
	})
})
