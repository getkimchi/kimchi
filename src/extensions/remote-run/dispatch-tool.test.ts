import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DISPATCH_TO_CLOUD_AGENT_TOOL, registerDispatchToCloudAgentTool } from "./dispatch-tool.js"
import { runCloudAgent } from "./runner.js"

vi.mock("./runner.js", () => ({
	runCloudAgent: vi.fn(),
	isRemoteRunEnabled: vi.fn(() => true),
}))

vi.mock("../ferment/prompt-ui.js", () => ({ withWorkingHidden: vi.fn((_ui, fn) => fn()) }))

interface RegisteredTool {
	name: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
}

function setup(confirmResult = true): {
	tool: RegisteredTool
	ctx: ExtensionContext
	confirm: ReturnType<typeof vi.fn>
} {
	const tools: RegisteredTool[] = []
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool)
		},
	} as unknown as ExtensionAPI
	registerDispatchToCloudAgentTool(pi)
	const confirm = vi.fn(async () => confirmResult)
	const ctx = { hasUI: true, ui: { confirm, notify: vi.fn() } } as unknown as ExtensionContext
	return { tool: tools[0], ctx, confirm }
}

async function callExecute(
	tool: RegisteredTool,
	ctx: ExtensionContext,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	return tool.execute("call-1", params, signal, undefined, ctx)
}

describe("registerDispatchToCloudAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("registers a tool named dispatch_to_cloud_agent", () => {
		const { tool } = setup()
		expect(tool.name).toBe(DISPATCH_TO_CLOUD_AGENT_TOOL)
	})

	it("shows a pure decision dialog with no briefing content, and dispatches on confirmation", async () => {
		const { tool, ctx, confirm } = setup(true)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-7", result: "backgrounded", backgrounded: true })

		const result = await callExecute(tool, ctx, { task: "Implement the auth feature", description: "cloud: auth" })

		const [title, message] = confirm.mock.calls[0]
		expect(title).toBe("Dispatch to remote agent?")
		expect(message).toContain("A self-contained task brief will be sent to the remote agent")
		expect(message).toContain("Conversation history is not transferred")
		// The dialog references the chat-presented briefing; it must NOT
		// embed the task itself — chat is the reading surface.
		expect(message).not.toContain("Implement the auth feature")
		expect(runCloudAgent).toHaveBeenCalledWith(expect.anything(), ctx, "Implement the auth feature", "cloud: auth", {
			background: true,
			origin: DISPATCH_TO_CLOUD_AGENT_TOOL,
		})
		expect(result.content[0].text).toContain("agent-7")
		expect(result.details).toEqual({ agentId: "agent-7" })
	})

	it("long briefings: dialog stays content-free, full text is dispatched unchanged", async () => {
		const { tool, ctx, confirm } = setup(true)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-11", result: "backgrounded", backgrounded: true })
		const lines = Array.from({ length: 10 }, (_, i) => `section ${i + 1} of the plan`)
		const task = lines.join("\n")

		await callExecute(tool, ctx, { task })

		const [, message] = confirm.mock.calls[0]
		expect(message).not.toContain("section 1 of the plan")
		expect(runCloudAgent).toHaveBeenCalledWith(expect.anything(), ctx, task, expect.any(String), expect.anything())
	})

	it("derives the description from the task when omitted", async () => {
		const { tool, ctx } = setup(true)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-8", result: "backgrounded", backgrounded: true })

		await callExecute(tool, ctx, { task: "Fix the flaky login test" })

		expect(runCloudAgent).toHaveBeenCalledWith(
			expect.anything(),
			ctx,
			"Fix the flaky login test",
			"remote session: Fix the flaky login test",
			{ background: true, origin: DISPATCH_TO_CLOUD_AGENT_TOOL },
		)
	})

	it("declined dialog: no spawn, model is told not to retry", async () => {
		const { tool, ctx } = setup(false)

		const result = await callExecute(tool, ctx, { task: "Implement the auth feature" })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("declined")
		expect(result.content[0].text).toContain("Do NOT retry")
		expect(result.details).toEqual({ error: "declined" })
	})

	it("refuses when there is no UI to confirm with", async () => {
		const { tool } = setup(true)
		const ctx = { hasUI: false, ui: { confirm: vi.fn(), notify: vi.fn() } } as unknown as ExtensionContext

		const result = await callExecute(tool, ctx, { task: "Implement the auth feature" })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("no interactive UI")
		expect(result.details).toEqual({ error: "no_ui" })
	})

	it("rejects an empty task before showing any dialog", async () => {
		const { tool, ctx, confirm } = setup(true)

		const result = await callExecute(tool, ctx, { task: "   " })

		expect(confirm).not.toHaveBeenCalled()
		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("must not be empty")
		expect(result.details).toEqual({ error: "empty_task" })
	})

	it("rejects a non-string task without throwing (schema-validation bypass)", async () => {
		const { tool, ctx, confirm } = setup(true)

		const result = await callExecute(tool, ctx, { task: 42 })

		expect(confirm).not.toHaveBeenCalled()
		expect(result.details).toEqual({ error: "empty_task" })
	})

	it("returns 'Dispatch cancelled' when the signal is already aborted — before any dialog", async () => {
		const { tool, ctx, confirm } = setup(true)
		const aborted = new AbortController()
		aborted.abort()

		const result = await callExecute(tool, ctx, { task: "Do the thing" }, aborted.signal)

		expect(confirm).not.toHaveBeenCalled()
		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toBe("Dispatch cancelled.")
		expect(result.details).toEqual({ error: "cancelled" })
	})

	it("returns a model-visible error instead of throwing when the spawn fails", async () => {
		const { tool, ctx } = setup(true)
		vi.mocked(runCloudAgent).mockRejectedValue(new Error("workspace unreachable"))

		const result = await callExecute(tool, ctx, { task: "Do the thing" })

		expect(result.content[0].text).toContain("Could not dispatch the remote agent: workspace unreachable")
		expect(result.details).toEqual({ error: "workspace unreachable" })
	})

	it("does not crash on a non-string description", async () => {
		const { tool, ctx } = setup(true)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-10", result: "backgrounded", backgrounded: true })

		const result = await callExecute(tool, ctx, { task: "Do the thing", description: 123 })

		expect(runCloudAgent).toHaveBeenCalledWith(
			expect.anything(),
			ctx,
			"Do the thing",
			"remote session: Do the thing",
			expect.anything(),
		)
		expect(result.details).toEqual({ agentId: "agent-10" })
	})
})
