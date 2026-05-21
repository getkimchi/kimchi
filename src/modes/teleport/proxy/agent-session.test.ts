import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { ReconnectSupervisor } from "../ws/reconnect.js"
import type { RemoteRpcClient } from "../ws/rpc-client.js"
import { RemoteAgentSession } from "./agent-session.js"

function createFakeRpcClient(): {
	client: RemoteRpcClient
	emitEvent: (event: Record<string, unknown>) => void
} {
	let eventListener: ((event: Record<string, unknown>) => void) | undefined

	const client = {
		send: vi.fn().mockResolvedValue(undefined),
		sendOneWay: vi.fn().mockResolvedValue(undefined),
		onEvent: vi.fn((cb) => {
			eventListener = cb as (event: Record<string, unknown>) => void
			return () => {
				eventListener = undefined
			}
		}),
		close: vi.fn(),
	} as unknown as RemoteRpcClient

	const emitEvent = (event: Record<string, unknown>) => {
		eventListener?.(event)
	}

	return { client, emitEvent }
}

describe("RemoteAgentSession", () => {
	it("forwards prompt to RPC client", async () => {
		const { client } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		await session.prompt("Hello")
		expect(client.send).toHaveBeenCalledWith("prompt", { message: "Hello" })
	})

	it("forwards abort to RPC client", async () => {
		const { client } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		await session.abort()
		expect(client.send).toHaveBeenCalledWith("abort", {})
	})

	it("accumulates messages from agent_end events", () => {
		const { client, emitEvent } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		const listener = vi.fn()
		session.subscribe(listener)

		emitEvent({ type: "agent_start" })
		emitEvent({
			type: "message_end",
			message: { role: "assistant", content: "Hello" },
		})
		emitEvent({
			type: "agent_end",
			messages: [
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: "Hello" },
			],
		})

		expect(session.messages).toHaveLength(2)
		expect(session.isStreaming).toBe(false)
	})

	it("emits translated events to listeners", () => {
		const { client, emitEvent } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		const listener = vi.fn()
		session.subscribe(listener)

		emitEvent({ type: "agent_start" })

		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "agent_start",
			}),
		)
	})

	it("handles extension_ui_request with buffered requests when ui is not bound", () => {
		const { client, emitEvent } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		emitEvent({
			type: "extension_ui_request",
			id: "req-1",
			method: "confirm",
			title: "Confirm?",
			message: "Are you sure?",
		})

		// Should not crash or send response since no UI is bound
		expect(client.sendOneWay).not.toHaveBeenCalled()
	})

	it("forwards setModel to RPC client", async () => {
		const { client } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		await session.setModel({ provider: "openai", id: "gpt-4" })
		expect(client.send).toHaveBeenCalledWith("set_model", {
			provider: "openai",
			modelId: "gpt-4",
		})
	})

	it("tracks isStreaming state through agent_start and agent_end", () => {
		const { client, emitEvent } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		expect(session.isStreaming).toBe(false)
		emitEvent({ type: "agent_start" })
		expect(session.isStreaming).toBe(true)
		emitEvent({ type: "agent_end", messages: [] })
		expect(session.isStreaming).toBe(false)
	})

	it("calls supervisor.dispose on dispose", () => {
		const { client } = createFakeRpcClient()
		const supervisor = { dispose: vi.fn() } as unknown as ReconnectSupervisor
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor,
			sessionId: "sess-1",
		})

		session.dispose()
		expect(supervisor.dispose).toHaveBeenCalled()
	})

	it("returns navigatorTree rejection", async () => {
		const { client } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		await expect(session.navigateTree()).rejects.toThrow("navigateTree is not supported in remote mode")
	})

	it("exposes sessionId", () => {
		const { client } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-42",
		})

		expect(session.sessionId).toBe("sess-42")
	})

	it("accumulates token usage from message_end events with usage data", () => {
		const { client, emitEvent } = createFakeRpcClient()
		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor: {} as ReconnectSupervisor,
			sessionId: "sess-1",
		})

		emitEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: "test",
				usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
			},
		})

		const stats = session.getSessionStats()
		expect(stats.tokens.input).toBe(100)
		expect(stats.tokens.output).toBe(50)
		expect(stats.tokens.cacheRead).toBe(10)
		expect(stats.tokens.cacheWrite).toBe(5)
	})
})
