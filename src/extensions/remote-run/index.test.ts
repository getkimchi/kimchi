import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DISPATCH_TO_CLOUD_AGENT_TOOL } from "./dispatch-tool.js"
import remoteRunExtension from "./index.js"

vi.mock("./runner.js", () => ({
	runCloudAgent: vi.fn(),
	isRemoteRunEnabled: vi.fn(() => true),
}))

vi.mock("../agents/index.js", () => ({
	getActiveManager: vi.fn(),
}))

type InputHandler = (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult | undefined>

type Handler = (...args: never[]) => unknown

interface CapturedTool {
	name: string
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
}

function makePi(opts?: { activeTools?: string[] }): {
	pi: ExtensionAPI
	inputHandlers: InputHandler[]
	handlers: Map<string, Handler[]>
	tools: CapturedTool[]
	commands: string[]
	fire: (event: string) => void
} {
	const handlers = new Map<string, Handler[]>()
	const inputHandlers: InputHandler[] = []
	const tools: CapturedTool[] = []
	const commands: string[] = []
	const pi = {
		registerTool: (tool: CapturedTool) => tools.push(tool),
		registerCommand: (name: string) => commands.push(name),
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler])
			if (event === "input") inputHandlers.push(handler as unknown as InputHandler)
		},
		getActiveTools: () => opts?.activeTools ?? [DISPATCH_TO_CLOUD_AGENT_TOOL],
	} as unknown as ExtensionAPI
	const fire = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler()
	}
	return { pi, inputHandlers, handlers, tools, commands, fire }
}

function makeCtx(confirmResult: boolean): {
	ctx: ExtensionContext
	confirm: ReturnType<typeof vi.fn>
	notify: ReturnType<typeof vi.fn>
} {
	const confirm = vi.fn(async () => confirmResult)
	const notify = vi.fn()
	const ctx = { hasUI: true, ui: { confirm, notify } } as unknown as ExtensionContext
	return { ctx, confirm, notify }
}

function inputEvent(text: string, over?: Partial<InputEvent>): InputEvent {
	return { type: "input", text, source: "interactive", ...over } as InputEvent
}

describe("remoteRunExtension", () => {
	const orig = process.env.KIMCHI_REMOTE_RUN

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		if (orig === undefined) delete process.env.KIMCHI_REMOTE_RUN
		else process.env.KIMCHI_REMOTE_RUN = orig
	})

	it("registers nothing when KIMCHI_REMOTE_RUN is unset", () => {
		delete process.env.KIMCHI_REMOTE_RUN
		const { pi, inputHandlers, tools } = makePi()
		remoteRunExtension(pi)
		expect(tools).toEqual([])
		expect(inputHandlers).toEqual([])
	})

	it("registers the dispatch tool and input handler when enabled", () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers, tools, handlers } = makePi()
		remoteRunExtension(pi)
		expect(tools.map((t) => t.name)).toContain(DISPATCH_TO_CLOUD_AGENT_TOOL)
		expect(inputHandlers).toHaveLength(1)
		expect(handlers.get("turn_end")).toHaveLength(1)
	})

	it("ignores prompts that don't start with the trigger phrase", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const { ctx, confirm } = makeCtx(true)

		const result = await inputHandlers[0](inputEvent("implement the login feature"), ctx)

		expect(result).toBeUndefined()
		expect(confirm).not.toHaveBeenCalled()
	})

	it("ignores non-interactive sources and mid-turn steers", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const { ctx, confirm } = makeCtx(true)

		expect(await inputHandlers[0](inputEvent("continue in remote session", { source: "rpc" }), ctx)).toBeUndefined()
		expect(
			await inputHandlers[0](inputEvent("continue in remote session", { streamingBehavior: "steer" }), ctx),
		).toBeUndefined()
		expect(confirm).not.toHaveBeenCalled()
	})

	it("passes the phrase through when the dispatch tool isn't active (plan/ferment profiles)", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi({ activeTools: ["read", "write"] })
		remoteRunExtension(pi)
		const { ctx, confirm } = makeCtx(true)

		const result = await inputHandlers[0](inputEvent("continue in remote session"), ctx)

		expect(result).toBeUndefined()
		expect(confirm).not.toHaveBeenCalled()
	})

	it("passes the phrase through without a UI (no way to confirm)", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const ctx = { hasUI: false, ui: { confirm: vi.fn(), notify: vi.fn() } } as unknown as ExtensionContext

		expect(await inputHandlers[0](inputEvent("continue in remote session"), ctx)).toBeUndefined()
	})

	it("returns handled when the user declines the confirm dialog", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const { ctx, confirm, notify } = makeCtx(false)

		const result = await inputHandlers[0](inputEvent("continue in remote session"), ctx)

		expect(confirm).toHaveBeenCalledOnce()
		expect(result).toEqual({ action: "handled" })
		expect(notify).toHaveBeenCalledWith("Staying in this session.", "info")
	})

	it("transforms the prompt into dispatch instructions when confirmed", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const { ctx } = makeCtx(true)

		const result = await inputHandlers[0](inputEvent("continue in remote session"), ctx)

		expect(result?.action).toBe("transform")
		const text = (result as { action: "transform"; text: string }).text
		expect(text).toContain("dispatch_to_cloud_agent")
		expect(text).toContain("continue in remote session")
	})

	it("includes the focus in the confirm dialog and the transformed instructions", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers } = makePi()
		remoteRunExtension(pi)
		const { ctx, confirm } = makeCtx(true)

		const result = await inputHandlers[0](inputEvent("continue in remote session: cover the auth refactor"), ctx)

		const [, message] = confirm.mock.calls[0]
		expect(message).toContain("Focus: cover the auth refactor")
		const text = (result as { action: "transform"; text: string }).text
		expect(text).toContain('"cover the auth refactor"')
	})
})

describe("dispatch gate wiring", () => {
	const orig = process.env.KIMCHI_REMOTE_RUN

	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		if (orig === undefined) delete process.env.KIMCHI_REMOTE_RUN
		else process.env.KIMCHI_REMOTE_RUN = orig
	})

	async function executeCapturedTool(tools: CapturedTool[], ctx: ExtensionContext) {
		const tool = tools.find((t) => t.name === DISPATCH_TO_CLOUD_AGENT_TOOL)
		if (!tool) throw new Error("dispatch tool not registered")
		return tool.execute("call-1", { task: "Do the thing" }, undefined, undefined, ctx)
	}

	it("arms the gate on confirmation — the tool can then dispatch", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers, tools } = makePi()
		remoteRunExtension(pi)
		const { ctx } = makeCtx(true)
		const { runCloudAgent } = await import("./runner.js")
		vi.mocked(runCloudAgent).mockResolvedValue({ id: "agent-live", result: "backgrounded", backgrounded: true })

		const result = await inputHandlers[0](inputEvent("continue in remote session"), ctx)
		expect(result?.action).toBe("transform")

		const dispatch = await executeCapturedTool(tools, ctx)
		expect(dispatch.details).toEqual({ agentId: "agent-live" })
	})

	it("declining the dialog leaves the gate unarmed — the tool refuses", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers, tools } = makePi()
		remoteRunExtension(pi)
		const { ctx } = makeCtx(false)

		await inputHandlers[0](inputEvent("continue in remote session"), ctx)

		const dispatch = await executeCapturedTool(tools, ctx)
		expect(dispatch.details).toEqual({ error: "not_armed" })
	})

	it("turn_end expires an armed-but-unused latch", async () => {
		process.env.KIMCHI_REMOTE_RUN = "1"
		const { pi, inputHandlers, tools, fire } = makePi()
		remoteRunExtension(pi)
		const { ctx } = makeCtx(true)
		const { runCloudAgent } = await import("./runner.js")

		await inputHandlers[0](inputEvent("continue in remote session"), ctx)
		fire("turn_end")

		const dispatch = await executeCapturedTool(tools, ctx)
		expect(dispatch.details).toEqual({ error: "not_armed" })
		expect(runCloudAgent).not.toHaveBeenCalled()
	})
})
