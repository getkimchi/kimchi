import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDispatchGate, type DispatchGate } from "./dispatch-gate.js"
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

function setup(): { tools: RegisteredTool[]; gate: DispatchGate; tool: RegisteredTool } {
	const { pi, tools } = makePi()
	const gate = createDispatchGate()
	registerDispatchToCloudAgentTool(pi, gate)
	return { tools, gate, tool: tools[0] }
}

async function callExecute(tool: RegisteredTool, params: Record<string, unknown>, signal?: AbortSignal) {
	return tool.execute("call-1", params, signal, undefined, ctx)
}

describe("registerDispatchToCloudAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("registers a tool named dispatch_to_cloud_agent", () => {
		const { tools } = setup()
		expect(tools.map((t) => t.name)).toEqual([DISPATCH_TO_CLOUD_AGENT_TOOL])
	})

	it("refuses to dispatch when the gate is not armed", async () => {
		const { tool } = setup()

		const result = await callExecute(tool, { task: "Implement the auth feature" })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("user-confirmed request")
		expect(result.details).toEqual({ error: "not_armed" })
	})

	it("dispatches via runCloudAgent in background with remote session origin when armed", async () => {
		const { tool, gate } = setup()
		gate.arm()
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-7", result: "backgrounded", backgrounded: true })

		const result = await callExecute(tool, { task: "Implement the auth feature", description: "cloud: auth" })

		expect(runCloudAgent).toHaveBeenCalledWith(expect.anything(), ctx, "Implement the auth feature", "cloud: auth", {
			background: true,
			origin: "remote session",
		})
		expect(result.content[0].text).toContain("agent-7")
		expect(result.details).toEqual({ agentId: "agent-7" })
	})

	it("derives the description from the task when omitted", async () => {
		const { tool, gate } = setup()
		gate.arm()
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-8", result: "backgrounded", backgrounded: true })

		await callExecute(tool, { task: "Fix the flaky login test" })

		expect(runCloudAgent).toHaveBeenCalledWith(
			expect.anything(),
			ctx,
			"Fix the flaky login test",
			"remote session: Fix the flaky login test",
			{ background: true, origin: "remote session" },
		)
	})

	it("consumes the gate on dispatch — a second call refuses", async () => {
		const { tool, gate } = setup()
		gate.arm()
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-9", result: "backgrounded", backgrounded: true })

		await callExecute(tool, { task: "Do the thing" })
		const second = await callExecute(tool, { task: "Do it again" })

		expect(runCloudAgent).toHaveBeenCalledTimes(1)
		expect(gate.isArmed()).toBe(false)
		expect(second.details).toEqual({ error: "not_armed" })
	})

	it("rejects an empty task without dispatching — and does not consume the gate", async () => {
		const { tool, gate } = setup()
		gate.arm()

		const result = await callExecute(tool, { task: "   " })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("must not be empty")
		expect(result.details).toEqual({ error: "empty_task" })
		expect(gate.isArmed()).toBe(true)
	})

	it("rejects a non-string task without throwing (schema-validation bypass)", async () => {
		const { tool, gate } = setup()
		gate.arm()

		const result = await callExecute(tool, { task: 42 })

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.details).toEqual({ error: "empty_task" })
		expect(gate.isArmed()).toBe(true)
	})

	it("returns 'Dispatch cancelled' when the signal is already aborted — without consuming the gate", async () => {
		const { tool, gate } = setup()
		gate.arm()
		const aborted = new AbortController()
		aborted.abort()

		const result = await callExecute(tool, { task: "Do the thing" }, aborted.signal)

		expect(runCloudAgent).not.toHaveBeenCalled()
		expect(result.content[0].text).toBe("Dispatch cancelled.")
		expect(result.details).toEqual({ error: "cancelled" })
		expect(gate.isArmed()).toBe(true)
	})

	it("returns a model-visible error instead of throwing when the spawn fails — and consumes the gate", async () => {
		const { tool, gate } = setup()
		gate.arm()
		vi.mocked(runCloudAgent).mockRejectedValue(new Error("workspace unreachable"))

		const result = await callExecute(tool, { task: "Do the thing" })

		expect(result.content[0].text).toContain("Could not dispatch the cloud agent: workspace unreachable")
		expect(result.details).toEqual({ error: "workspace unreachable" })
		expect(gate.isArmed()).toBe(false)
	})

	it("does not crash on a non-string description", async () => {
		const { tool, gate } = setup()
		gate.arm()
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-10", result: "backgrounded", backgrounded: true })

		const result = await callExecute(tool, { task: "Do the thing", description: 123 })

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
