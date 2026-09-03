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
	cwd: "/home/sandbox/acp-test1234",
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

		it("updates text in place when full text is accumulated", () => {
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

		it("trims leading newlines from assistant text", () => {
			const session = new RemoteAgentSession()
			session.appendAssistantText("\n\nHello world")
			expect(session.messages[0].content).toEqual([{ type: "text", text: "Hello world" }])
		})

		it("preserves toolCall parts when updating text after a tool call", () => {
			const session = new RemoteAgentSession()
			// Simulate ACP: onTextDelta sends full accumulated text
			session.appendAssistantText("thinking...")
			session.recordToolCallStart("bash")
			session.recordToolCallEnd("bash")
			// ACP sends full accumulated text including pre-tool text;
			// appendAssistantText slices from _textOffset to get only post-tool text
			session.appendAssistantText("thinking...Done")

			// Last assistant message should have the post-tool text
			const last = session.messages[session.messages.length - 1]
			expect(last.role).toBe("assistant")
			const parts = last.content as Array<{ type: string; text?: string; name?: string }>
			const textPart = parts.find((p) => p.type === "text")
			expect(textPart?.text).toBe("Done")
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

	describe("setUserPrompt", () => {
		it("adds a user message as the first message", () => {
			const session = new RemoteAgentSession()
			session.setUserPrompt("build the thing")
			expect(session.messages).toHaveLength(1)
			expect(session.messages[0]).toEqual({ role: "user", content: "build the thing" })
		})

		it("does not add a duplicate user message on second call", () => {
			const session = new RemoteAgentSession()
			session.setUserPrompt("first")
			session.setUserPrompt("second")
			expect(session.messages).toHaveLength(1)
			expect(session.messages[0]).toEqual({ role: "user", content: "first" })
		})

		it("emits a message_start event", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			session.subscribe(listener)
			session.setUserPrompt("hello")
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener.mock.calls[0][0]).toMatchObject({ type: "message_start" })
		})
	})

	describe("appendAssistantText emits events", () => {
		it("emits message_update on each text append", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			session.subscribe(listener)

			session.appendAssistantText("Hello")
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener.mock.calls[0][0]).toMatchObject({ type: "message_update" })

			session.appendAssistantText("Hello world")
			expect(listener).toHaveBeenCalledTimes(2)
		})
	})

	describe("recordToolCallStart", () => {
		it("adds a toolCall to an existing assistant message", () => {
			const session = new RemoteAgentSession()
			session.appendAssistantText("thinking...")
			session.recordToolCallStart("bash")

			expect(session.messages).toHaveLength(1)
			const content = session.messages[0].content as Array<{ type: string; name?: string; id?: string }>
			expect(content).toHaveLength(2)
			expect(content[1]).toMatchObject({ type: "toolCall", name: "bash", id: "tc-1", arguments: {} })
		})

		it("creates a new assistant message when none exists", () => {
			const session = new RemoteAgentSession()
			session.recordToolCallStart("read")
			expect(session.messages).toHaveLength(1)
			expect(session.messages[0].role).toBe("assistant")
		})

		it("emits tool_execution_start", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			session.subscribe(listener)
			session.recordToolCallStart("bash")
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener.mock.calls[0][0]).toMatchObject({ type: "tool_execution_start", toolName: "bash" })
		})

		describe("deduplication", () => {
			it("skips duplicate in_progress for the same tool name", () => {
				const session = new RemoteAgentSession()
				const listener = vi.fn()
				session.subscribe(listener)

				session.recordToolCallStart("bash")
				session.recordToolCallStart("bash") // ACP re-sends in_progress

				expect(listener).toHaveBeenCalledTimes(1)
				const parts = session.messages[0].content as Array<{ type: string; name?: string }>
				const toolCalls = parts.filter((p) => p.type === "toolCall")
				expect(toolCalls).toHaveLength(1)
			})

			it("allows the same tool name after the previous call ends", () => {
				const session = new RemoteAgentSession()

				session.recordToolCallStart("bash")
				session.recordToolCallEnd("bash")
				session.recordToolCallStart("bash")

				const assistantMsgs = session.messages.filter((m) => m.role === "assistant")
				const toolCalls = assistantMsgs.flatMap((m) =>
					(m.content as Array<{ type: string; name?: string }>).filter((p) => p.type === "toolCall"),
				)
				expect(toolCalls).toHaveLength(2)
			})

			it('skips fallback "tool" name when a real tool is pending', () => {
				const session = new RemoteAgentSession()
				const listener = vi.fn()
				session.subscribe(listener)

				session.recordToolCallStart("pnpm run typecheck")
				session.recordToolCallStart("pnpm run typecheck") // duplicate in_progress

				expect(listener).toHaveBeenCalledTimes(1)
				const parts = session.messages[0].content as Array<{ type: string; name?: string }>
				const toolCalls = parts.filter((p) => p.type === "toolCall")
				expect(toolCalls).toHaveLength(1)
				expect(toolCalls[0].name).toBe("pnpm run typecheck")
			})
		})
	})

	describe("recordToolCallEnd", () => {
		it("adds a toolResult message", () => {
			const session = new RemoteAgentSession()
			session.recordToolCallStart("bash")
			session.recordToolCallEnd("bash")

			expect(session.messages).toHaveLength(2)
			expect(session.messages[1]).toMatchObject({
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "bash",
				content: [{ type: "text", text: "(completed)" }],
				isError: false,
			})
		})

		it("marks error results", () => {
			const session = new RemoteAgentSession()
			session.recordToolCallStart("bash")
			session.recordToolCallEnd("bash", undefined, true)

			const msg = session.messages[1]
			expect(msg.isError).toBe(true)
			const result = msg.content as Array<{ type: string; text: string }>
			expect(result[0].text).toBe("(tool failed)")
		})

		it("emits tool_execution_end", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			session.subscribe(listener)
			session.recordToolCallEnd("bash")
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener.mock.calls[0][0]).toMatchObject({ type: "tool_execution_end", toolName: "bash" })
		})
	})

	describe("full conversation flow", () => {
		it("builds a complete transcript from user prompt through tool calls", () => {
			const session = new RemoteAgentSession()
			const listener = vi.fn()
			session.subscribe(listener)

			session.setUserPrompt("do stuff")
			// Simulate ACP: onTextDelta sends full accumulated text per turn
			session.appendAssistantText("I'll run a command")
			session.recordToolCallStart("bash")
			session.recordToolCallEnd("bash")
			// ACP sends full text including pre-tool text; sliced to post-tool text
			session.appendAssistantText("I'll run a commandDone")

			expect(session.messages).toHaveLength(4)
			expect(session.messages[0].role).toBe("user")
			expect(session.messages[1].role).toBe("assistant")
			expect(session.messages[2].role).toBe("toolResult")
			expect(session.messages[3].role).toBe("assistant")
			// The post-tool assistant message should only have post-tool text
			const postToolParts = session.messages[3].content as Array<{ type: string; text?: string }>
			const textPart = postToolParts.find((p) => p.type === "text")
			expect(textPart?.text).toBe("Done")
			// listener called for every mutation except the initial user prompt
			// (setUserPrompt emits message_start)
			expect(listener).toHaveBeenCalledTimes(5)
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
