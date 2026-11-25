import { describe, expect, it, vi } from "vitest"
import { SUBAGENT_TOOL_ID_ENTRY_TYPE, SubagentToolIdHistory } from "./subagent-tool-ids.js"

function entry(piToolCallId: string, acpToolCallId: string): unknown {
	return {
		type: "custom",
		customType: SUBAGENT_TOOL_ID_ENTRY_TYPE,
		data: { version: 1, piToolCallId, acpToolCallId },
	}
}

describe("child tool ID history", () => {
	it("persists each live assignment once and keeps later matched updates", () => {
		const persist = vi.fn()
		const history = new SubagentToolIdHistory(persist)
		history.record("pi-one", "kt.read.0")
		history.record("pi-one", "kt.read.0")
		history.record("pi-two", "kt.bash.2")
		expect(persist).toHaveBeenCalledTimes(2)
		expect(persist).toHaveBeenNthCalledWith(2, {
			version: 1,
			piToolCallId: "pi-two",
			acpToolCallId: "kt.bash.2",
		})
		expect(history.nextSequenceFloor()).toBe(3)
	})

	it("restores mappings in branch order, including recycled provider ids, without writing on replay", () => {
		const history = SubagentToolIdHistory.fromEntries([
			entry("same-id", "kt.bash.0"),
			entry("other", "kt.read.1"),
			entry("same-id", "kt.bash.2"),
			{ type: "custom", customType: SUBAGENT_TOOL_ID_ENTRY_TYPE, data: { version: 0 } },
			{ type: "message" },
		])
		expect(history.nextSequenceFloor()).toBe(3)
		expect(history.takeForReplay("same-id")).toBe("kt.bash.0")
		expect(history.takeForReplay("same-id")).toBe("kt.bash.2")
		expect(history.takeForReplay("same-id")).toBeUndefined()
		expect(history.takeForReplay("other")).toBe("kt.read.1")
	})
})
