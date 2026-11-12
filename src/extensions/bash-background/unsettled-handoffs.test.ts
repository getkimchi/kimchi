import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { BASH_BACKGROUND_SETTLE_MESSAGE_TYPE } from "../../shared/bash-background-settle.js"
import { findUnsettledHandoffs } from "./unsettled-handoffs.js"

let seq = 0
function toolResult(toolCallId: string, details: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id: `e${++seq}`,
		parentId: null,
		timestamp: "",
		message: { role: "toolResult", toolCallId, content: [], details },
	} as unknown as SessionEntry
}

function settle(toolCallId: string): SessionEntry {
	return {
		type: "custom",
		id: `e${++seq}`,
		parentId: null,
		timestamp: "",
		customType: BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
		data: { toolCallId, isError: false, text: "", details: { exited: true, exitCode: 0 } },
	} as unknown as SessionEntry
}

const handoff = { handoff: true, handle: "h-1", exited: false }

describe("findUnsettledHandoffs", () => {
	it("reports a handoff with no matching settle", () => {
		expect(findUnsettledHandoffs([toolResult("call-1", handoff)])).toEqual([{ toolCallId: "call-1", handle: "h-1" }])
	})

	it("closes a handoff with a later settle under the same id", () => {
		expect(findUnsettledHandoffs([toolResult("call-1", handoff), settle("call-1")])).toEqual([])
	})

	it("ignores terminal results that were never handoffs", () => {
		expect(
			findUnsettledHandoffs([
				toolResult("call-1", { exited: true, exitCode: 0 }),
				toolResult("call-2", { handoff: false, handle: "h-2" }),
				toolResult("call-3", {}),
			]),
		).toEqual([])
	})

	it("reports each of several unsettled handoffs in transcript order", () => {
		const entries = [
			toolResult("call-1", { handoff: true, handle: "h-1", exited: false }),
			toolResult("call-2", { handoff: true, handle: "h-2", exited: false }),
			settle("call-2"),
			toolResult("call-3", { handoff: true, handle: "h-3", exited: false }),
		]
		expect(findUnsettledHandoffs(entries)).toEqual([
			{ toolCallId: "call-1", handle: "h-1" },
			{ toolCallId: "call-3", handle: "h-3" },
		])
	})

	it("consumes settles FIFO under a recycled toolCallId", () => {
		// Same id handed off twice, settled once: the EARLY handoff closes,
		// the later one stays open (the replay side's consumption rule).
		const entries = [
			toolResult("call-1", { handoff: true, handle: "h-old" }),
			settle("call-1"),
			toolResult("call-1", { handoff: true, handle: "h-new" }),
		]
		expect(findUnsettledHandoffs(entries)).toEqual([{ toolCallId: "call-1", handle: "h-new" }])
	})

	it("ignores malformed settle entries at the trust boundary", () => {
		const bogus = {
			type: "custom",
			id: "e-x",
			parentId: null,
			timestamp: "",
			customType: BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
			data: { nope: true },
		} as unknown as SessionEntry
		expect(findUnsettledHandoffs([toolResult("call-1", handoff), bogus])).toEqual([
			{ toolCallId: "call-1", handle: "h-1" },
		])
	})
})
