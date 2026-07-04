import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import stripStaleThinkingExtension, {
	findLatestUserMessageIndex,
	stripStaleThinkingBeforeLatestUser,
} from "./strip-stale-thinking.js"

type Message = ContextEvent["messages"][number]
type Handler = (event: ContextEvent) => unknown

function text(text: string): TextContent {
	return { type: "text", text }
}

function thinking(thinkingText: string, thinkingSignature = "sig"): ThinkingContent {
	return { type: "thinking", thinking: thinkingText, thinkingSignature }
}

function toolCall(id = "call-1"): ToolCall {
	return { type: "toolCall", id, name: "bash", arguments: { command: "pwd" } }
}

function user(content: string): UserMessage {
	return { role: "user", content: [text(content)], timestamp: 0 }
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	}
}

function toolResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [text("/repo")],
		details: undefined,
		isError: false,
		timestamp: 0,
	}
}

function context(messages: Message[]): ContextEvent {
	return { type: "context", messages }
}

describe("stripStaleThinkingBeforeLatestUser", () => {
	it("finds the latest user message", () => {
		const messages = [user("one"), assistant([text("ok")]), user("two")]

		expect(findLatestUserMessageIndex(messages)).toBe(2)
	})

	it("strips thinking blocks only before the latest user message", () => {
		const oldAssistant = assistant([thinking("old reasoning"), text("old answer")])
		const activeAssistant = assistant([thinking("active reasoning"), toolCall()])
		const messages = [user("first"), oldAssistant, user("second"), activeAssistant, toolResult()]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect(result).not.toBe(messages)
		expect((result[1] as AssistantMessage).content).toEqual([text("old answer")])
		expect(result[2]).toBe(messages[2])
		expect(result[3]).toBe(activeAssistant)
		expect((result[3] as AssistantMessage).content).toEqual([thinking("active reasoning"), toolCall()])
		expect(result[4]).toBe(messages[4])
	})

	it("keeps old assistant messages unchanged when stripping would empty them", () => {
		// Dropping a thinking-only prior turn could leave two consecutive user
		// turns (nothing downstream coalesces same-role messages), so keep it.
		const messages = [user("first"), assistant([thinking("only reasoning")]), user("second")]

		expect(stripStaleThinkingBeforeLatestUser(messages)).toBe(messages)
	})

	it("strips redacted thinking blocks from old assistant messages", () => {
		const redacted = thinking("", "opaque-payload")
		redacted.redacted = true
		const messages = [user("first"), assistant([redacted, text("answer")]), user("second")]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([text("answer")])
	})

	it("keeps tool calls and text on old assistant messages", () => {
		const messages = [user("first"), assistant([thinking("old"), toolCall(), text("done")]), user("second")]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([toolCall(), text("done")])
	})

	it("returns the original array when nothing changes", () => {
		const messages = [user("first"), assistant([text("ok")]), user("second")]

		expect(stripStaleThinkingBeforeLatestUser(messages)).toBe(messages)
	})

	it("does not strip when there is no latest user boundary", () => {
		const messages = [assistant([thinking("old")])]

		expect(stripStaleThinkingBeforeLatestUser(messages)).toBe(messages)
	})

	it("strips inline <think> tags from old assistant text, keeping the answer", () => {
		const messages = [user("first"), assistant([text("before <think>stale reasoning</think> after")]), user("second")]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([text("before  after")])
	})

	it("strips inline <mm:think> (MiniMax) tags from old assistant text", () => {
		const messages = [user("first"), assistant([text("<mm:think>plan</mm:think>the answer")]), user("second")]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([text("the answer")])
	})

	it("keeps inline reasoning in the current (in-progress) turn", () => {
		const active = assistant([text("<mm:think>still thinking</mm:think>partial")])
		const messages = [user("first"), assistant([text("<think>old</think>done")]), user("second"), active, toolResult()]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([text("done")])
		expect(result[3]).toBe(active)
	})

	it("drops a text block that was pure inline reasoning but keeps tool calls", () => {
		const messages = [
			user("first"),
			assistant([text("<mm:think>let me run pwd</mm:think>"), toolCall()]),
			user("second"),
		]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([toolCall()])
	})

	it("keeps a message unchanged when inline reasoning was its only content", () => {
		const messages = [user("first"), assistant([text("<mm:think>only reasoning</mm:think>")]), user("second")]

		expect(stripStaleThinkingBeforeLatestUser(messages)).toBe(messages)
	})

	it("strips both a native thinking block and inline tags in the same old message", () => {
		const messages = [
			user("first"),
			assistant([thinking("native"), text("<think>inline</think>answer")]),
			user("second"),
		]

		const result = stripStaleThinkingBeforeLatestUser(messages)

		expect((result[1] as AssistantMessage).content).toEqual([text("answer")])
	})
})

describe("stripStaleThinkingExtension", () => {
	it("registers a context handler that returns replacement messages only when changed", async () => {
		const on = vi.fn()
		stripStaleThinkingExtension({ on } as unknown as ExtensionAPI)
		const handler = on.mock.calls[0]?.[1] as Handler

		expect(on).toHaveBeenCalledWith("context", expect.any(Function))

		const changed = await handler(
			context([user("first"), assistant([thinking("old"), text("answer")]), user("second")]),
		)
		expect(changed).toMatchObject({
			messages: [
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant", content: [text("answer")] }),
				expect.objectContaining({ role: "user" }),
			],
		})

		const unchangedMessages = [user("first"), assistant([text("ok")]), user("second")]
		await expect(handler(context(unchangedMessages))).resolves.toBeUndefined()
	})
})
