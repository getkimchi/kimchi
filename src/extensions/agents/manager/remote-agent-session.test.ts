import { describe, expect, it, vi } from "vitest"
import { RemoteAgentSession } from "./remote-agent-session.js"

function makeMockAcpClient() {
	return {
		prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn", usage: undefined }),
		cancel: vi.fn().mockResolvedValue(undefined),
		close: vi.fn(),
		initialize: vi.fn().mockResolvedValue(undefined),
		sessionId: "test-session-id",
	}
}

const META = {
	workspaceId: "ws-1",
	sessionName: "acp-test1234",
	wsUrl: "wss://worker.example.com",
	host: "worker.example.com",
}

describe("RemoteAgentSession", () => {
	describe("bindClient", () => {
		it("stores the client and metadata", () => {
			const session = new RemoteAgentSession()
			const client = makeMockAcpClient()
			session.bindClient(client as never, META)
			expect(session.sessionId).toBe("acp-test1234")
		})

		it("sessionId is empty string before bindClient", () => {
			const session = new RemoteAgentSession()
			expect(session.sessionId).toBe("")
		})
	})

	describe("steer", () => {
		it("throws 'not supported' error", async () => {
			const session = new RemoteAgentSession()
			const client = makeMockAcpClient()
			session.bindClient(client as never, META)
			await expect(session.steer("do something")).rejects.toThrow("Steering is not supported for remote agents")
		})

		it("does not call acpClient.prompt", async () => {
			const session = new RemoteAgentSession()
			const client = makeMockAcpClient()
			session.bindClient(client as never, META)
			await expect(session.steer("msg")).rejects.toThrow()
			expect(client.prompt).not.toHaveBeenCalled()
		})
	})

	describe("abort", () => {
		it("calls acpClient.cancel()", async () => {
			const session = new RemoteAgentSession()
			const client = makeMockAcpClient()
			session.bindClient(client as never, META)
			await session.abort()
			expect(client.cancel).toHaveBeenCalledTimes(1)
		})

		it("does not throw when client is not bound", async () => {
			const session = new RemoteAgentSession()
			await expect(session.abort()).resolves.toBeUndefined()
		})
	})

	describe("dispose", () => {
		it("does NOT call acpClient.close()", () => {
			const session = new RemoteAgentSession()
			const client = makeMockAcpClient()
			session.bindClient(client as never, META)
			session.dispose()
			expect(client.close).not.toHaveBeenCalled()
		})
	})

	describe("addUsage", () => {
		it("accumulates usage across multiple calls", () => {
			const session = new RemoteAgentSession()
			session.addUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 })
			session.addUsage({ input: 200, output: 30, cacheRead: 20, cacheWrite: 15 })

			const stats = session.getSessionStats()
			expect(stats.tokens).toEqual({ input: 300, output: 80, cacheRead: 30, cacheWrite: 20 })
		})

		it("getSessionStats returns a copy of usage", () => {
			const session = new RemoteAgentSession()
			session.addUsage({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 })
			const stats1 = session.getSessionStats()
			stats1.tokens.input = 999
			const stats2 = session.getSessionStats()
			expect(stats2.tokens.input).toBe(100)
		})
	})

	describe("subscribe / emit", () => {
		it("delivers emitted events to subscribers", () => {
			const session = new RemoteAgentSession()
			const listener1 = vi.fn()
			const listener2 = vi.fn()
			session.subscribe(listener1)
			session.subscribe(listener2)

			const event = { type: "turn_end" } as never
			session.emit(event)
			expect(listener1).toHaveBeenCalledWith(event)
			expect(listener2).toHaveBeenCalledWith(event)
		})

		it("unsubscribe stops delivering events", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			const unsub = session.subscribe(listener)
			unsub()
			const event = { type: "turn_end" } as never
			session.emit(event)
			expect(listener).not.toHaveBeenCalled()
		})
	})

	describe("appendAssistantText", () => {
		it("creates a new message when none exists", () => {
			const session = new RemoteAgentSession()
			session.appendAssistantText("hello")
			expect(session.messages).toHaveLength(1)
			expect(session.messages[0]).toEqual({
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			})
		})

		it("replaces last assistant message when full text is accumulated", () => {
			const session = new RemoteAgentSession()
			session.appendAssistantText("Hello")
			session.appendAssistantText("Hello world")
			session.appendAssistantText("Hello world done")
			// Should be 1 message, not 3 — ACP sends accumulated full text
			expect(session.messages).toHaveLength(1)
			expect(session.messages[0]).toEqual({
				role: "assistant",
				content: [{ type: "text", text: "Hello world done" }],
			})
		})
	})

	describe("turnCount", () => {
		it("increments and returns turn count", () => {
			const session = new RemoteAgentSession()
			expect(session.turnCount).toBe(0)
			session.incrementTurnCount()
			session.incrementTurnCount()
			expect(session.turnCount).toBe(2)
		})
	})

	describe("model / getContextUsage / isStreaming", () => {
		it("model is always undefined", () => {
			const session = new RemoteAgentSession()
			expect(session.model).toBeUndefined()
		})

		it("getContextUsage is always undefined", () => {
			const session = new RemoteAgentSession()
			expect(session.getContextUsage()).toBeUndefined()
		})

		it("isStreaming tracks setStreaming", () => {
			const session = new RemoteAgentSession()
			expect(session.isStreaming).toBe(false)
			session.setStreaming(true)
			expect(session.isStreaming).toBe(true)
			session.setStreaming(false)
			expect(session.isStreaming).toBe(false)
		})
	})
})
