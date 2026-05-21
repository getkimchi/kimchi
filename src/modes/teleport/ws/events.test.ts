import { describe, expect, it } from "vitest"
import { translateRpcEvent } from "./events.js"

describe("translateRpcEvent", () => {
	it("passes core AgentEvent types through (agent_start)", () => {
		const event = { type: "agent_start" }
		const result = translateRpcEvent(event)
		expect(result).toEqual(event)
	})

	it("passes agent_end with messages through", () => {
		const event = {
			type: "agent_end",
			messages: [{ role: "assistant", parts: [] }],
		}
		const result = translateRpcEvent(event)
		expect(result).toEqual(event)
	})

	it("returns undefined for unknown event types", () => {
		const result = translateRpcEvent({ type: "unknown_gibberish" })
		expect(result).toBeUndefined()
	})

	it("passes tool execution events through", () => {
		const event = {
			type: "tool_execution_start",
			toolCallId: "t-1",
			toolName: "read",
			args: { file: "test.txt" },
		}
		const result = translateRpcEvent(event)
		expect(result).toEqual(event)
	})

	it("passes session-specific extras (thinking_level_changed) through", () => {
		const event = { type: "thinking_level_changed", level: "high" }
		const result = translateRpcEvent(event)
		expect(result).toEqual(event)
	})

	it("passes queue_update through", () => {
		const event = {
			type: "queue_update",
			steering: ["a"],
			followUp: ["b"],
		}
		const result = translateRpcEvent(event)
		expect(result).toEqual(event)
	})
})
