import type { AssistantMessage, Context, ToolCall, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	CRITICAL_REVISION_ERROR_MESSAGE,
	hasInvalidToolCalls,
	hasSerializedToolCallMarkup,
	isValidRevision,
	LEAD_OUTPUT_SYSTEM_PROMPT,
	LEAD_RETRY_SYSTEM_PROMPT,
	publicContent,
	REVISION_SYSTEM_PROMPT,
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
	it("exports the established lead and revision safeguards", () => {
		expect(LEAD_OUTPUT_SYSTEM_PROMPT).toContain("user-facing answer or a valid tool call")
		expect(LEAD_RETRY_SYSTEM_PROMPT).toContain("without a user-facing answer or tool call")
		expect(REVISION_SYSTEM_PROMPT).toContain("Never serialize tool calls as text")
		expect(CRITICAL_REVISION_ERROR_MESSAGE).toBe("Council could not safely finalize the reviewed response.")
	})

	it("strips thinking and preserves public blocks exactly", () => {
		const text = { type: "text" as const, text: "done" }
		const call = toolCall()
		expect(publicContent(message([{ type: "thinking", thinking: "private" }, text, call], "toolUse"))).toEqual([
			text,
			call,
		])
	})

	it("accepts advertised tool calls with plain or null-prototype arguments", () => {
		const nullPrototypeArguments = Object.assign(Object.create(null), { path: "a.txt" })
		expect(hasInvalidToolCalls([toolCall()], context)).toBe(false)
		expect(hasInvalidToolCalls([toolCall({ arguments: nullPrototypeArguments })], context)).toBe(false)
	})

	it.each([
		["blank id", toolCall({ id: " " })],
		["blank name", toolCall({ name: " " })],
		["unadvertised name", toolCall({ name: "write" })],
		["null arguments", toolCall({ arguments: null as unknown as ToolCall["arguments"] })],
		["array arguments", toolCall({ arguments: [] as unknown as ToolCall["arguments"] })],
		["custom-prototype arguments", toolCall({ arguments: new Date() as unknown as ToolCall["arguments"] })],
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

	it("validates coherent text and tool-call revisions", () => {
		expect(isValidRevision(message([{ type: "text", text: "done" }], "stop"), context)).toBe(true)
		expect(isValidRevision(message([toolCall()], "toolUse"), context)).toBe(true)
		expect(isValidRevision(message([{ type: "thinking", thinking: "private" }, toolCall()], "toolUse"), context)).toBe(
			true,
		)
	})

	it.each([
		["blank text", message([{ type: "text", text: "  " }], "stop")],
		["wrong text termination", message([{ type: "text", text: "done" }], "length")],
		["wrong tool termination", message([toolCall()], "stop")],
		["unadvertised tool", message([toolCall({ name: "write" })], "toolUse")],
		["serialized tool markup", message([{ type: "text", text: "<|tool_call_begin|> read" }], "stop")],
	])("rejects %s revisions", (_label, revision) => {
		expect(isValidRevision(revision, context)).toBe(false)
	})
})
