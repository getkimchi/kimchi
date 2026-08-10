import type { AssistantMessage, Context, ToolCall, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	hasInvalidToolCalls,
	hasSerializedToolCallMarkup,
	LEAD_OUTPUT_SYSTEM_PROMPT,
	LEAD_RETRY_SYSTEM_PROMPT,
	LEAD_VERIFY_STAGED_SYSTEM_PROMPT,
	publicContent,
} from "./finalizer.js"

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const context: Context = {
	messages: [],
	tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 1,
	}
}

const toolCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
	type: "toolCall",
	id: "call_1",
	name: "read",
	arguments: { path: "a.txt" },
	...overrides,
})

describe("final response boundary", () => {
	it("exports the lead safeguards", () => {
		expect(LEAD_OUTPUT_SYSTEM_PROMPT).toContain("user-facing answer or a valid tool call")
		expect(LEAD_RETRY_SYSTEM_PROMPT).toContain("without a user-facing answer or tool call")
		expect(LEAD_VERIFY_STAGED_SYSTEM_PROMPT).toContain("council_check_candidate")
		expect(LEAD_VERIFY_STAGED_SYSTEM_PROMPT).toContain("fix the staged files and check again")
	})

	it("strips thinking and preserves public blocks exactly", () => {
		const text = { type: "text" as const, text: "done" }
		const call = toolCall()
		expect(publicContent(message([{ type: "thinking", thinking: "private" }, text, call], "toolUse"))).toEqual([
			text,
			call,
		])
	})

	it("accepts advertised tool calls with plain, null-prototype, or custom-prototype object arguments", () => {
		const nullPrototypeArguments = Object.assign(Object.create(null), { path: "a.txt" })
		expect(hasInvalidToolCalls([toolCall()], context)).toBe(false)
		expect(hasInvalidToolCalls([toolCall({ arguments: nullPrototypeArguments })], context)).toBe(false)
		expect(
			hasInvalidToolCalls([toolCall({ arguments: new Date() as unknown as ToolCall["arguments"] })], context),
		).toBe(false)
	})

	it.each([
		["blank id", toolCall({ id: " " })],
		["blank name", toolCall({ name: " " })],
		["unadvertised name", toolCall({ name: "write" })],
		["null arguments", toolCall({ arguments: null as unknown as ToolCall["arguments"] })],
		["array arguments", toolCall({ arguments: [] as unknown as ToolCall["arguments"] })],
	])("rejects %s", (_label, call) => {
		expect(hasInvalidToolCalls([call], context)).toBe(true)
	})

	it("rejects duplicate tool-call ids", () => {
		expect(hasInvalidToolCalls([toolCall(), toolCall({ name: "read" })], context)).toBe(true)
	})

	it.each([
		"<|tool_calls_section_begin|>",
		"<|tool_call_begin|>",
		"<|tool_call_argument_begin|>",
	])("detects serialized marker %s", (marker) => {
		expect(hasSerializedToolCallMarkup(`prefix ${marker} suffix`)).toBe(true)
	})
})
