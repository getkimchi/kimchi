import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

vi.mock("./superpowers/installer.js", () => ({
	ensureSuperpowersInstalled: vi.fn().mockResolvedValue(false),
}))
vi.mock("./superpowers/bootstrap.js", () => ({
	buildSuperpowersBootstrap: vi.fn().mockReturnValue("bootstrap content"),
}))
vi.mock("./agent-worker-context.js", () => ({
	isAgentWorker: vi.fn().mockReturnValue(false),
}))

import superpowersExtension from "./superpowers.js"

type HandlerFn = (...args: unknown[]) => unknown

function makeApi(handlers: Record<string, HandlerFn>): ExtensionAPI {
	return {
		on: (event: string, handler: HandlerFn) => {
			handlers[event] = handler
		},
	} as unknown as ExtensionAPI
}

describe("superpowersExtension", () => {
	it("registers session_start handler", () => {
		const onSpy = vi.fn()
		superpowersExtension({ on: onSpy } as unknown as ExtensionAPI)
		expect(onSpy).toHaveBeenCalledWith("session_start", expect.any(Function))
	})

	it("registers before_agent_start handler", () => {
		const onSpy = vi.fn()
		superpowersExtension({ on: onSpy } as unknown as ExtensionAPI)
		expect(onSpy).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
	})

	it("before_agent_start returns systemPrompt with bootstrap prepended", async () => {
		const handlers: Record<string, HandlerFn> = {}
		superpowersExtension(makeApi(handlers))

		const event = { systemPrompt: "existing prompt", type: "before_agent_start" }
		const ctx = { hasUI: false }
		const result = await handlers.before_agent_start(event, ctx)

		expect(result).toEqual({ systemPrompt: "bootstrap content\n\nexisting prompt" })
	})

	it("before_agent_start returns undefined when isAgentWorker is true", async () => {
		const { isAgentWorker } = await import("./agent-worker-context.js")
		vi.mocked(isAgentWorker).mockReturnValue(true)

		const handlers: Record<string, HandlerFn> = {}
		superpowersExtension(makeApi(handlers))

		const result = await handlers.before_agent_start({ systemPrompt: "x" }, {})
		expect(result).toBeUndefined()
	})

	it("before_agent_start returns undefined when bootstrap is empty string", async () => {
		const { isAgentWorker } = await import("./agent-worker-context.js")
		vi.mocked(isAgentWorker).mockReturnValue(false)
		const { buildSuperpowersBootstrap } = await import("./superpowers/bootstrap.js")
		vi.mocked(buildSuperpowersBootstrap).mockReturnValue("")

		const handlers: Record<string, HandlerFn> = {}
		superpowersExtension(makeApi(handlers))

		const result = await handlers.before_agent_start({ systemPrompt: "x" }, {})
		expect(result).toBeUndefined()
	})
})
