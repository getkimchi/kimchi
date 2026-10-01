import { describe, expect, it } from "vitest"
import { ACP_REATTACH_MID_TURN_META_KEY, buildToolCallId, parseToolCallId } from "./acp-protocol.js"

describe("acp-protocol", () => {
	it("pins the reattach meta key value (cross-version wire contract)", () => {
		expect(ACP_REATTACH_MID_TURN_META_KEY).toBe("kimchi/reattachMidTurn")
	})

	it("builds the byte-identical toolCallId format", () => {
		expect(buildToolCallId("bash", 3)).toBe("kt.bash.3")
		expect(buildToolCallId("web_fetch", 2)).toBe("kt.web_fetch.2")
		expect(buildToolCallId("read", 0)).toBe("kt.read.0")
	})

	it("round-trips plain tool names", () => {
		expect(parseToolCallId(buildToolCallId("bash", 1))).toEqual({ toolName: "bash" })
	})

	it("round-trips multi-dot tool names", () => {
		expect(parseToolCallId(buildToolCallId("web_fetch", 2))).toEqual({ toolName: "web_fetch" })
	})

	it("round-trips seq 0 and large seqs", () => {
		expect(parseToolCallId(buildToolCallId("read", 0))).toEqual({ toolName: "read" })
		expect(parseToolCallId(buildToolCallId("read", 987654321))).toEqual({ toolName: "read" })
	})

	it("returns null for non-matching ids", () => {
		expect(parseToolCallId("tc-1")).toBeNull()
		expect(parseToolCallId("kt.bash")).toBeNull()
		expect(parseToolCallId("kt.bash.x")).toBeNull()
		expect(parseToolCallId("kt.1")).toBeNull()
		expect(parseToolCallId("prefix.kt.bash.1")).toBeNull()
		expect(parseToolCallId("")).toBeNull()
	})
})
