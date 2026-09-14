import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DISPATCH_TO_CLOUD_AGENT_TOOL, registerDispatchToCloudAgentTool } from "./dispatch-tool.js"
import { runCloudAgent } from "./runner.js"

vi.mock("./runner.js", () => ({
	runCloudAgent: vi.fn(),
	isRemoteRunEnabled: vi.fn(() => true),
}))

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

function makePi(): { pi: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = []
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool)
		},
	} as unknown as ExtensionAPI
	return { pi, tools }
}

const ctx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext

async function callExecute(tool: RegisteredTool, params: Record<string, unknown>) {
	return tool.execute("call-1", params, undefined, undefined, ctx)
}

describe("registerDispatchToCloudAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("registers a tool named dispatch_to_cloud_agent", () => {
		const { pi, tools } = makePi()
		registerDispatchToCloudAgentTool(pi)
		expect(tools.map((t) => t.name)).toEqual([DISPATCH_TO_CLOUD_AGENT_TOOL])
	})

	it("dispatches via runCloudAgent in background with remote session origin", async () => {
		const { pi, tools } = makePi()
		registerDispatchToCloudAgentTool(pi)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-7", result: "backgrounded", backgrounded: true })

		const result = await callExecute(tools[0], { task: "Implement the auth feature", description: "cloud: auth" })

		expect(runCloudAgent).toHaveBeenCalledWith(pi, ctx, "Implement the auth feature", "cloud: auth", {
			background: true,
			origin: "remote session",
		})
		expect(result.content[0].text).toContain("agent-7")
		expect(result.details).toEqual({ agentId: "agent-7" })
	})

	it("derives the description from the task when omitted", async () => {
		const { pi, tools } = makePi()
		registerDispatchToCloudAgentTool(pi)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-8", result: "backgrounded", backgrounded: true })

		await callExecute(tools[0], { task: "Fix the flaky login test" })

		expect(runCloudAgent).toHaveBeenCalledWith(
			pi,
			ctx,
			"Fix the flaky login test",
			"remote session: Fix the flaky login test",
			{
				background: true,
				origin: "remote session",
			},
		)
	})

	it("rejects an empty task without dispatching", async () => {
		const { pi, tools } = makePi()
		registerDispatchToCloudAgentTool(pi)

		const result = await callExecute(tools[0], { task: "   " })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("must not be empty")
		expect(result.details).toEqual({ error: "empty_task" })
	})

	it("returns a model-visible error instead of throwing when the spawn fails", async () => {
		const { pi, tools } = makePi()
		registerDispatchToCloudAgentTool(pi)
		vi.mocked(runCloudAgent).mockRejectedValue(new Error("workspace unreachable"))

		const result = await callExecute(tools[0], { task: "Do the thing" })

		expect(result.content[0].text).toContain("Could not dispatch the cloud agent: workspace unreachable")
		expect(result.details).toEqual({ error: "workspace unreachable" })
	})
})
