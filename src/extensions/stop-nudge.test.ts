import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const api = {
		on,
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI
	return { api, handlers }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[list.length - 1]
}

const CTX = { sessionManager: { getSessionId: () => "test-session" } }

function assistantStop(content: unknown[] = [{ type: "text", text: "done" }]): {
	message: { role: string; content: unknown[]; stopReason: string }
} {
	return { message: { role: "assistant", content, stopReason: "stop" } }
}

describe("stopNudgeExtension", () => {
	beforeEach(() => {
		vi.resetModules()
		// Default mocks: not a subagent, default permission mode (not plan),
		// no active ferment scoping.
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => false }))
		vi.doMock("./permissions/mode-controller.js", () => ({
			getPermissionMode: () => ({ mode: "default", source: "user" }),
		}))
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("fires a triggerTurn nudge on no-tool stop with stopReason 'stop' in default mode", async () => {
		const { api, handlers } = createMockApi()
		const { default: stopNudgeExtension } = await import("./stop-nudge.js")
		stopNudgeExtension(api)

		await getHandler(handlers, "session_start")({}, CTX)
		getHandler(handlers, "turn_end")(assistantStop(), CTX)

		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		const [msg, opts] = (api.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(msg.customType).toBe("single_model_stop_nudge")
		expect(msg.display).toBe(false)
		expect(opts).toEqual({ triggerTurn: true })
	})

	it("does not fire in plan mode", async () => {
		vi.doMock("./permissions/mode-controller.js", () => ({
			getPermissionMode: () => ({ mode: "plan", source: "user" }),
		}))
		const { api, handlers } = createMockApi()
		const { default: stopNudgeExtension } = await import("./stop-nudge.js")
		stopNudgeExtension(api)

		await getHandler(handlers, "session_start")({}, CTX)
		getHandler(handlers, "turn_end")(assistantStop(), CTX)

		expect(api.sendMessage).not.toHaveBeenCalled()
	})

	it("does not fire when tool calls are present in the turn", async () => {
		const { api, handlers } = createMockApi()
		const { default: stopNudgeExtension } = await import("./stop-nudge.js")
		stopNudgeExtension(api)

		await getHandler(handlers, "session_start")({}, CTX)
		getHandler(handlers, "turn_end")(assistantStop([{ type: "toolCall", toolName: "bash" }]), CTX)

		expect(api.sendMessage).not.toHaveBeenCalled()
	})

	it("does not fire after the cap (1) is reached", async () => {
		const { api, handlers } = createMockApi()
		const { default: stopNudgeExtension } = await import("./stop-nudge.js")
		stopNudgeExtension(api)

		await getHandler(handlers, "session_start")({}, CTX)
		// First stop: should fire.
		getHandler(handlers, "turn_end")(assistantStop(), CTX)
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
		// Second stop: should NOT fire (cap reached).
		getHandler(handlers, "turn_end")(assistantStop(), CTX)
		expect(api.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not fire for subagents (isAgentWorker() returns true)", async () => {
		vi.doMock("./agent-worker-context.js", () => ({ isAgentWorker: () => true }))
		const { api, handlers } = createMockApi()
		const { default: stopNudgeExtension } = await import("./stop-nudge.js")
		stopNudgeExtension(api)

		await getHandler(handlers, "session_start")({}, CTX)
		getHandler(handlers, "turn_end")(assistantStop(), CTX)

		expect(api.sendMessage).not.toHaveBeenCalled()
	})
})
