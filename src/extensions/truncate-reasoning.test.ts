import { beforeEach, describe, expect, it, vi } from "vitest"
import truncateReasoningExtension, { _resetState, _setTruncateReasoning } from "./truncate-reasoning.js"

type Handler = (event: unknown) => unknown

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	return { on, handlers, api: { on } as unknown as Parameters<typeof truncateReasoningExtension>[0] }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler registered for ${event}`)
	return list[0]
}

function setupExtension(): { handler: Handler } {
	const { handlers, api } = createMockApi()
	truncateReasoningExtension(api)
	return { handler: getHandler(handlers, "context") }
}

interface AssistantMessage {
	role: "assistant"
	content: Array<
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
		| { type: "toolCall"; id: string; name: string; arguments: unknown; thoughtSignature?: string }
	>
	[key: string]: unknown
}

function makeAssistant(extra: Record<string, unknown> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hello" }],
		...extra,
	}
}

describe("truncateReasoningExtension", () => {
	beforeEach(() => {
		_resetState()
	})

	it("is a no-op when the setting is disabled", async () => {
		_setTruncateReasoning(false)
		const { handler } = setupExtension()
		const msg = makeAssistant({ reasoning_content: "secret thoughts" })
		const result = await handler({ type: "context", messages: [msg] })
		expect(result).toBeUndefined()
		expect((msg as Record<string, unknown>).reasoning_content).toBe("secret thoughts")
	})

	it("defaults to enabled when no override and no settings.json field are set", async () => {
		// No _setTruncateReasoning call here — exercises the no-override, no-settings.json path.
		// (The test runner does not read KIMCHI_CODING_AGENT_DIR, so getSettingsPath returns undefined.)
		const { handler } = setupExtension()
		const msg = makeAssistant({ reasoning_content: "secret thoughts" })
		const result = await handler({ type: "context", messages: [msg] })
		expect(result).toEqual({ messages: [msg] })
		expect((msg as Record<string, unknown>).reasoning_content).toBeUndefined()
	})

	it("strips reasoning_content from assistant messages when enabled", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg = makeAssistant({ reasoning_content: "secret thoughts" })
		const result = await handler({ type: "context", messages: [msg] })
		expect(result).toEqual({ messages: [msg] })
		expect((msg as Record<string, unknown>).reasoning_content).toBeUndefined()
		expect(msg.content).toEqual([{ type: "text", text: "Hello" }])
	})

	it("strips reasoning_details arrays when enabled", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const details = [{ type: "reasoning.encrypted", id: "abc", data: "..." }]
		const msg = makeAssistant({ reasoning_details: details })
		await handler({ type: "context", messages: [msg] })
		expect((msg as Record<string, unknown>).reasoning_details).toBeUndefined()
	})

	it("strips all four known reasoning fields when present", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg = makeAssistant({
			reasoning_content: "a",
			reasoning: "b",
			reasoning_text: "c",
			reasoning_details: [{ type: "x" }],
		})
		await handler({ type: "context", messages: [msg] })
		const r = msg as Record<string, unknown>
		expect(r.reasoning_content).toBeUndefined()
		expect(r.reasoning).toBeUndefined()
		expect(r.reasoning_text).toBeUndefined()
		expect(r.reasoning_details).toBeUndefined()
	})

	it("returns undefined when no assistant message has any reasoning field", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg = makeAssistant()
		const result = await handler({ type: "context", messages: [msg] })
		expect(result).toBeUndefined()
	})

	it("leaves user and toolResult messages unchanged even when enabled", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const user = {
			role: "user" as const,
			content: "hi",
			reasoning_content: "should not be touched",
			timestamp: 0,
		}
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "x",
			toolName: "x",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
			reasoning_content: "should not be touched",
		}
		await handler({ type: "context", messages: [user, toolResult] })
		expect((user as Record<string, unknown>).reasoning_content).toBe("should not be touched")
		expect((toolResult as Record<string, unknown>).reasoning_content).toBe("should not be touched")
	})

	it("only modifies assistant messages that have a reasoning field; result length unchanged", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const clean = makeAssistant()
		const dirty = makeAssistant({ reasoning_content: "x" })
		const result = (await handler({
			type: "context",
			messages: [clean, dirty],
		})) as { messages: unknown[] }
		expect(result.messages).toHaveLength(2)
		expect((dirty as Record<string, unknown>).reasoning_content).toBeUndefined()
		expect((clean as Record<string, unknown>).reasoning_content).toBeUndefined()
	})

	it("preserves non-reasoning fields on the assistant message", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg = makeAssistant({
			reasoning_content: "x",
			model: "minimax-m3",
			usage: { input: 1, output: 2 },
		})
		await handler({ type: "context", messages: [msg] })
		expect(msg.model).toBe("minimax-m3")
		expect(msg.usage).toEqual({ input: 1, output: 2 })
		expect(msg.role).toBe("assistant")
		expect((msg as Record<string, unknown>).reasoning_content).toBeUndefined()
	})
	it("strips ThinkingContent block whose thinkingSignature is 'reasoning_content'", async () => {
		// This is the upstream openai-completions.js re-build path: if a
		// ThinkingContent block with thinkingSignature='reasoning_content' is
		// left in `content`, convertMessages re-populates the top-level
		// reasoning_content field on the outgoing payload.
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hello" },
				{ type: "thinking", thinking: "secret thoughts", thinkingSignature: "reasoning_content" },
			],
		}
		await handler({ type: "context", messages: [msg] })
		expect(msg.content).toEqual([{ type: "text", text: "Hello" }])
	})

	it("strips ThinkingContent block whose thinkingSignature is 'reasoning' or 'reasoning_text'", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "A" },
				{ type: "thinking", thinking: "x", thinkingSignature: "reasoning" },
				{ type: "text", text: "B" },
				{ type: "thinking", thinking: "y", thinkingSignature: "reasoning_text" },
			],
		}
		await handler({ type: "context", messages: [msg] })
		expect(msg.content).toEqual([
			{ type: "text", text: "A" },
			{ type: "text", text: "B" },
		])
	})

	it("preserves ThinkingContent block whose thinkingSignature is an opaque encrypted value (Anthropic)", async () => {
		// Anthropic extended thinking uses an opaque encrypted signature that does
		// NOT match any REASONING_FIELDS entry, so the block must pass through.
		// Stripping it would break tool-use reasoning continuity because the
		// signature must be preserved.
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const thinking = {
			type: "thinking" as const,
			thinking: "deep thoughts",
			thinkingSignature: "encrypted-blob-not-a-field-name",
		}
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Hello" }, thinking],
		}
		await handler({ type: "context", messages: [msg] })
		expect(msg.content).toEqual([{ type: "text", text: "Hello" }, thinking])
	})

	it("preserves ThinkingContent block with no thinkingSignature", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const thinking = { type: "thinking" as const, thinking: "..." }
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "..." }],
		}
		await handler({ type: "context", messages: [msg] })
		expect(msg.content).toEqual([thinking])
	})

	it("strips thoughtSignature from tool calls (otherwise convertMessages rebuilds reasoning_details)", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {}, thoughtSignature: '{"id":"abc"}' }],
		}
		await handler({ type: "context", messages: [msg] })
		const tc = msg.content[0] as { thoughtSignature?: string }
		expect(tc.thoughtSignature).toBeUndefined()
	})

	it("strips the full realistic case: top-level field + ThinkingContent block + tool call thoughtSignature", async () => {
		// Mirrors what the upstream openai-completions.js produces for a
		// reasoning-capable model like minimax-m3.
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hello" },
				{ type: "thinking", thinking: "secret thoughts", thinkingSignature: "reasoning_content" },
			],
			reasoning_content: "secret thoughts",
		}
		await handler({ type: "context", messages: [msg] })
		// Top-level field gone
		expect((msg as Record<string, unknown>).reasoning_content).toBeUndefined()
		// ThinkingContent block gone (so convertMessages can't rebuild it)
		expect(msg.content).toEqual([{ type: "text", text: "Hello" }])
	})
})

describe("truncateReasoningExtension end-to-end against upstream convertMessages", () => {
	// Simulates what openai-completions.js convertMessages does on the outgoing
	// payload: rebuilds `reasoning_content` from ThinkingContent blocks whose
	// thinkingSignature is an OpenAI-style field name, and rebuilds
	// `reasoning_details` from tool calls' thoughtSignature. If our context
	// hook clears all three sources, the rebuilt payload has no reasoning.
	beforeEach(() => {
		_resetState()
	})

	function simulateConvertMessages(msg: AssistantMessage): Record<string, unknown> {
		const out: Record<string, unknown> = {
			role: "assistant",
			content: "",
		}
		const textParts: string[] = []
		const thinkingBlocks = (msg.content as Array<{ type: string; [k: string]: unknown }>).filter(
			(b) => b.type === "thinking",
		)
		for (const block of msg.content as Array<{
			type: string
			text?: string
			thinking?: string
			[k: string]: unknown
		}>) {
			if (block.type === "text" && block.text) textParts.push(block.text)
		}
		if (textParts.length > 0) out.content = textParts.join("")
		if (thinkingBlocks.length > 0) {
			const first = thinkingBlocks[0] as unknown as { thinkingSignature?: string; thinking: string }
			if (first.thinkingSignature) {
				out[first.thinkingSignature] = thinkingBlocks
					.map((b) => (b as unknown as { thinking: string }).thinking)
					.join("\n")
			}
		}
		const toolCalls = (msg.content as Array<{ type: string; thoughtSignature?: string }>).filter(
			(b) => b.type === "toolCall",
		)
		const details = toolCalls
			.filter((tc) => tc.thoughtSignature)
			.map((tc) => {
				try {
					return JSON.parse(tc.thoughtSignature as string)
				} catch {
					return null
				}
			})
			.filter(Boolean)
		if (details.length > 0) out.reasoning_details = details
		return out
	}

	it("outgoing payload has no reasoning_content after our context hook runs", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Hello" },
				{ type: "thinking", thinking: "secret", thinkingSignature: "reasoning_content" },
			],
			reasoning_content: "secret",
		}
		await handler({ type: "context", messages: [msg] })
		const payload = simulateConvertMessages(msg)
		expect(payload.reasoning_content).toBeUndefined()
		expect(payload.content).toBe("Hello")
	})

	it("outgoing payload has no reasoning_details after our context hook runs", async () => {
		_setTruncateReasoning(true)
		const { handler } = setupExtension()
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: {}, thoughtSignature: '{"id":"x"}' }],
		}
		await handler({ type: "context", messages: [msg] })
		const payload = simulateConvertMessages(msg)
		expect(payload.reasoning_details).toBeUndefined()
	})
})
