import type { ToolResultMessage } from "@earendil-works/pi-ai"
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import hiddenToolGuidanceExtension from "./hidden-tool-guidance.js"

type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>

function makeToolResult(toolName: string, text = `Tool ${toolName} not found`): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName,
		content: [{ type: "text", text }],
		details: {},
		isError: true,
		timestamp: Date.now(),
	}
}

function createHarness() {
	const { api, getHandler } = createExtensionApi()
	hiddenToolGuidanceExtension(api)
	return getHandler<MessageEndEvent, unknown>("message_end")
}

describe("hidden tool guidance", () => {
	it("replaces a tool-not-found rejection when the result is created", async () => {
		const messageEnd = createHarness()
		const result = await messageEnd({ type: "message_end", message: makeToolResult("bash") }, {} as never)

		expect(result).toMatchObject({
			message: {
				role: "toolResult",
				content: [
					{
						type: "text",
						text: 'Tool bash not found: "bash" is not available in the current tool list. Continue with an available tool and retry only if "bash" appears there later.',
					},
				],
			},
		})
	})

	it("tells the model to re-emit when arguments were serialized into the tool name", async () => {
		// Real-world failure (glm-5.3-flash, 2026-09-30): the entire call arrived
		// as the function name with empty arguments; echoing it as "not available"
		// made the model wrongly conclude the Agent tool was missing.
		const messageEnd = createHarness()
		const toolName =
			'Agent description="Standards review" model="glm-5.3-flash" prompt</arg_key><arg_value>You are a review sub-agent. Review the diff now.'
		const echoedName = toolName.length > 120 ? `${toolName.slice(0, 120)}…` : toolName
		const result = await messageEnd({ type: "message_end", message: makeToolResult(toolName) }, {} as never)

		expect(result).toMatchObject({
			message: {
				role: "toolResult",
				content: [
					{
						type: "text",
						text: `Tool call rejected: the model serialized arguments into the function name ("${echoedName}") instead of emitting structured arguments. The intended tool is likely "Agent" and it may be available — re-emit the tool call with name "Agent" and proper JSON arguments.`,
					},
				],
			},
		})
	})

	it("flags single-token mangled names as malformed when no probable tool is recoverable", async () => {
		// Another plausible mangling: JSON serialized into the name with no
		// whitespace and no valid tool name embedded.
		const messageEnd = createHarness()
		const toolName = 'Agent{"prompt":"review-the-diff","model":"glm"}'
		const result = await messageEnd({ type: "message_end", message: makeToolResult(toolName) }, {} as never)

		expect(result).toMatchObject({
			message: {
				role: "toolResult",
				content: [
					{
						type: "text",
						text: `Tool call rejected: the function name ("${toolName}") is not a valid tool name, so the call was malformed rather than a request for a missing tool. Check the available tool list and re-emit the intended call with a valid name and structured arguments.`,
					},
				],
			},
		})
	})

	it("flags over-length names as malformed and truncates them in the guidance text", async () => {
		// >64 chars violates the tool-name grammar even when the content is a
		// single token, so this must not be reported as "not available".
		const messageEnd = createHarness()
		const longName = `${"x".repeat(200)}`
		const result = await messageEnd({ type: "message_end", message: makeToolResult(longName) }, {} as never)
		const block = (result as { message: ToolResultMessage } | undefined)?.message.content[0]
		const text = block?.type === "text" ? block.text : ""
		expect(text).toContain("Tool call rejected")
		expect(text).toContain("not a valid tool name")
		expect(text).toContain(`${"x".repeat(120)}…`)
		expect(text).not.toContain(longName)
	})

	it("keeps the original guidance for grammar-valid names at the 64-char boundary", async () => {
		const messageEnd = createHarness()
		const validName = "valid-".concat("a".repeat(58)) // exactly 64 chars, all valid
		const result = await messageEnd({ type: "message_end", message: makeToolResult(validName) }, {} as never)

		expect(result).toMatchObject({
			message: {
				role: "toolResult",
				content: [
					{
						type: "text",
						text: `Tool ${validName} not found: "${validName}" is not available in the current tool list. Continue with an available tool and retry only if "${validName}" appears there later.`,
					},
				],
			},
		})
	})

	it("leaves non-exact tool-not-found text unchanged", async () => {
		const messageEnd = createHarness()
		const message = makeToolResult("bash", "Tool bash not found: additional detail")

		expect(await messageEnd({ type: "message_end", message }, {} as never)).toBeUndefined()
	})

	it("leaves unrelated tool errors unchanged", async () => {
		const messageEnd = createHarness()
		const message = makeToolResult("bash", "Command timed out")

		expect(await messageEnd({ type: "message_end", message }, {} as never)).toBeUndefined()
	})
})
