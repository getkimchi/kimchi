import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { isKimiK2Model, normalizeKimiToolCallIds } from "./normalize-kimi-tool-call-ids.js"

type ContextMessage = ContextEvent["messages"][number]

function assistantWithToolCall(id: string, name: string): ContextMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: {} }],
	} as unknown as ContextMessage
}

function toolResult(toolCallId: string, toolName: string): ContextMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
	} as unknown as ContextMessage
}

function userMessage(): ContextMessage {
	return {
		role: "user",
		content: [{ type: "text", text: "continue" }],
	} as unknown as ContextMessage
}

describe("isKimiK2Model", () => {
	it.each([
		"kimi-k2",
		"kimi-k2.5",
		"kimi-k2.6",
		"kimi-k2.7",
		"kimi-k2.7-code",
		"kimi-k2-thinking",
	])("matches %s", (id) => {
		expect(isKimiK2Model(id)).toBe(true)
	})

	it.each(["kimi-k3", "glm-5.2-fp8", "minimax-m2.7", "deepseek-v4-flash", "gpt-5.4"])("does not match %s", (id) => {
		expect(isKimiK2Model(id)).toBe(false)
	})

	it("does not match undefined", () => {
		expect(isKimiK2Model(undefined)).toBe(false)
	})
})

describe("normalizeKimiToolCallIds", () => {
	it("returns the same array reference when there are no tool calls", () => {
		const messages = [userMessage()]
		expect(normalizeKimiToolCallIds(messages)).toBe(messages)
	})

	it("rewrites a non-canonical tool call id and the paired toolResult id", () => {
		const result = normalizeKimiToolCallIds([
			userMessage(),
			assistantWithToolCall("call_abc123", "read"),
			toolResult("call_abc123", "read"),
		])

		const assistant = result[1] as { content: { type: string; id: string }[] }
		const resultMsg = result[2] as { toolCallId: string }
		expect(assistant.content[0].id).toBe("functions.read:0")
		expect(resultMsg.toolCallId).toBe("functions.read:0")
	})

	it("increments the index globally across calls, keeping the tool name per call", () => {
		const result = normalizeKimiToolCallIds([
			assistantWithToolCall("call_1", "read"),
			toolResult("call_1", "read"),
			assistantWithToolCall("call_2", "bash"),
			toolResult("call_2", "bash"),
		])

		expect((result[0] as { content: { id: string }[] }).content[0].id).toBe("functions.read:0")
		expect((result[1] as { toolCallId: string }).toolCallId).toBe("functions.read:0")
		expect((result[2] as { content: { id: string }[] }).content[0].id).toBe("functions.bash:1")
		expect((result[3] as { toolCallId: string }).toolCallId).toBe("functions.bash:1")
	})

	it("renumbers already-canonical ids so the sequence stays globally unique", () => {
		// k2.7's own history uses canonical ids; rest of history may not.
		const result = normalizeKimiToolCallIds([
			assistantWithToolCall("functions.bash:7", "bash"),
			toolResult("functions.bash:7", "bash"),
		])

		expect((result[0] as { content: { id: string }[] }).content[0].id).toBe("functions.bash:0")
		expect((result[1] as { toolCallId: string }).toolCallId).toBe("functions.bash:0")
	})

	it("leaves toolResults without a matching tool call untouched", () => {
		const result = normalizeKimiToolCallIds([
			assistantWithToolCall("call_1", "read"),
			toolResult("call_orphan", "read"),
		])

		expect((result[1] as { toolCallId: string }).toolCallId).toBe("call_orphan")
	})

	it("passes non-matching messages through by reference and does not mutate the input", () => {
		const user = userMessage()
		const assistant = assistantWithToolCall("call_1", "read")
		const before = JSON.stringify([user, assistant])
		const result = normalizeKimiToolCallIds([user, assistant])

		expect(result[0]).toBe(user)
		expect(JSON.stringify([user, assistant])).toBe(before)
	})
})
