import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { withPrintGate } from "../print-mode.js"
import { DISPATCH_TO_CLOUD_AGENT_TOOL } from "./dispatch-tool.js"
import remoteRunExtension from "./index.js"
import { isRemoteRunEnabled, runCloudAgent } from "./runner.js"

vi.mock("./runner.js", () => ({
	runCloudAgent: vi.fn(),
	isRemoteRunEnabled: vi.fn(() => true),
}))

vi.mock("../agents/index.js", () => ({
	getActiveManager: vi.fn(),
}))

interface CapturedTool {
	name: string
}

interface CapturedCommand {
	description: string
	handler: (args: string, ctx: ExtensionContext) => Promise<void>
}

function makePi(): {
	pi: ExtensionAPI
	tools: CapturedTool[]
	commands: Map<string, CapturedCommand>
	handlers: Map<string, Array<() => void>>
} {
	const tools: CapturedTool[] = []
	const commands = new Map<string, CapturedCommand>()
	const handlers = new Map<string, Array<() => void>>()
	const pi = {
		registerTool: (tool: CapturedTool) => tools.push(tool),
		registerCommand: (name: string, command: CapturedCommand) => commands.set(name, command),
		on: (event: string, handler: () => void) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler])
		},
	} as unknown as ExtensionAPI
	return { pi, tools, commands, handlers }
}

describe("remoteRunExtension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isRemoteRunEnabled).mockReturnValue(true)
	})

	it("registers nothing when remote run is disabled", () => {
		vi.mocked(isRemoteRunEnabled).mockReturnValue(false)
		const { pi, tools, commands, handlers } = makePi()
		remoteRunExtension(pi)
		expect(tools).toEqual([])
		expect(commands.size).toBe(0)
		expect(handlers.size).toBe(0)
	})

	it("registers the dispatch tool, /remote-run command, and shutdown handler when enabled", () => {
		const { pi, tools, commands, handlers } = makePi()
		remoteRunExtension(pi)
		expect(tools.map((t) => t.name)).toEqual([DISPATCH_TO_CLOUD_AGENT_TOOL])
		expect([...commands.keys()]).toEqual(["remote-run"])
		expect(handlers.get("session_shutdown")).toHaveLength(1)
	})

	it("does not register the dispatch tool in --print runs, but keeps the command and shutdown handler", async () => {
		await withPrintGate({ print: true }, () => {
			const { pi, tools, commands, handlers } = makePi()
			remoteRunExtension(pi)
			expect(tools).toEqual([])
			expect([...commands.keys()]).toEqual(["remote-run"])
			expect(handlers.get("session_shutdown")).toHaveLength(1)
		})
	})

	it("does not lift the print suppression for ferment-oneshot runs", async () => {
		await withPrintGate({ print: true, fermentOneshot: true }, () => {
			const { pi, tools } = makePi()
			remoteRunExtension(pi)
			expect(tools).toEqual([])
		})
	})

	it("/remote-run shows usage on empty args", async () => {
		const { pi, commands } = makePi()
		remoteRunExtension(pi)
		const notify = vi.fn()
		const ctx = { ui: { notify } } as unknown as ExtensionContext

		await commands.get("remote-run")?.handler("  ", ctx)

		expect(notify).toHaveBeenCalledWith("Usage: /remote-run <prompt>", "warning")
		expect(runCloudAgent).not.toHaveBeenCalled()
	})

	it("/remote-run dispatches the raw prompt in the background", async () => {
		const { pi, commands } = makePi()
		remoteRunExtension(pi)
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-cmd", result: "backgrounded", backgrounded: true })
		const ctx = { ui: { notify: vi.fn() } } as unknown as ExtensionContext

		await commands.get("remote-run")?.handler("fix the flaky test", ctx)

		expect(runCloudAgent).toHaveBeenCalledWith(pi, ctx, "fix the flaky test", "remote: fix the flaky test", {
			background: true,
		})
	})
})
