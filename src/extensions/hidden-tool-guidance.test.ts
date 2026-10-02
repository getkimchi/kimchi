import type { ToolResultMessage } from "@earendil-works/pi-ai"
import type { ExtensionEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import { createDeferredReveal } from "./deferred-reveal.js"
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
	const { api, getHandler, getActiveToolNames } = createExtensionApi()
	hiddenToolGuidanceExtension(api)
	return { api, messageEnd: getHandler<MessageEndEvent, unknown>("message_end"), getActiveToolNames }
}

describe("hidden tool guidance", () => {
	it("replaces a tool-not-found rejection when the result is created", async () => {
		const { messageEnd } = createHarness()
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
		const { messageEnd } = createHarness()
		const message = makeToolResult("bash", "Tool bash not found: additional detail")

		expect(await messageEnd({ type: "message_end", message }, {} as never)).toBeUndefined()
	})

	it("leaves unrelated tool errors unchanged", async () => {
		const { messageEnd } = createHarness()
		const message = makeToolResult("bash", "Command timed out")

		expect(await messageEnd({ type: "message_end", message }, {} as never)).toBeUndefined()
	})

	it("reveals the whole deferred suite (and releases its vote) on not-found", async () => {
		const { api, messageEnd } = createHarness()
		const visibility = { enable: vi.fn(), disable: vi.fn() }
		const names = ["resume_subagent", "steer_subagent"]
		createDeferredReveal(api, visibility, names, { anchorToolName: "Agent" })
		visibility.disable(names)

		const result = await messageEnd({ type: "message_end", message: makeToolResult("steer_subagent") }, {} as never)
		// The vote is released through the owning deferral, not a bare setActiveTools.
		expect(visibility.enable).toHaveBeenCalledWith(names)
		// ...and the in-band load marker covers the whole suite (cache-stable surface).
		expect(result).toMatchObject({ message: { addedToolNames: names } })
	})

	it("reveals a deferred suite only once", async () => {
		const { api, messageEnd } = createHarness()
		const visibility = { enable: vi.fn(), disable: vi.fn() }
		createDeferredReveal(api, visibility, ["once_a", "once_b"], { anchorToolName: "Agent" })

		await messageEnd({ type: "message_end", message: makeToolResult("once_a") }, {} as never)
		const second = (await messageEnd({ type: "message_end", message: makeToolResult("once_b") }, {} as never)) as {
			message: Record<string, unknown>
		}
		expect(visibility.enable).toHaveBeenCalledTimes(1)
		expect(second.message).not.toHaveProperty("addedToolNames")
	})

	it("does not reveal a registered tool that is inactive for a non-deferral reason", async () => {
		const { api, messageEnd, getActiveToolNames } = createHarness()
		// e.g. the PowerShell platform gate or plan mode: registered, hidden, not a deferred suite
		api.registerTool({ name: "powershell" } as never)
		api.setActiveTools(api.getActiveTools().filter((n) => n !== "powershell"))

		const result = (await messageEnd({ type: "message_end", message: makeToolResult("powershell") }, {} as never)) as {
			message: Record<string, unknown>
		}
		expect(getActiveToolNames()).not.toContain("powershell")
		expect(result.message).not.toHaveProperty("addedToolNames")
	})

	it("does not stamp addedToolNames for genuinely unknown tool names", async () => {
		const { messageEnd } = createHarness()
		const result = (await messageEnd(
			{ type: "message_end", message: makeToolResult("not_a_real_tool") },
			{} as never,
		)) as {
			message: Record<string, unknown>
		}
		expect(result.message).not.toHaveProperty("addedToolNames")
	})

	it("does not reveal genuinely unknown tool names", async () => {
		const { messageEnd, getActiveToolNames } = createHarness()
		await messageEnd({ type: "message_end", message: makeToolResult("not_a_real_tool") }, {} as never)
		expect(getActiveToolNames()).not.toContain("not_a_real_tool")
	})
})
