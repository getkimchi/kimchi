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
