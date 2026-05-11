import { beforeEach, describe, expect, it, vi } from "vitest"
import { ANSI, fg } from "../ansi.js"
import hideThinkingExtension, {
	_getDisplayToOriginal,
	_resetState,
	_setHideThinking,
	filterThinkingForDisplay,
} from "./hide-thinking.js"

type Handler = (event: unknown) => unknown

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	return { on, handlers, api: { on } as unknown as Parameters<typeof hideThinkingExtension>[0] }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler registered for ${event}`)
	return list[0]
}

interface Handlers {
	messageStart: Handler
	messageUpdate: Handler
	messageEnd: Handler
	context: Handler
}

function setupExtension(): Handlers {
	const { handlers, api } = createMockApi()
	hideThinkingExtension(api)
	return {
		messageStart: getHandler(handlers, "message_start"),
		messageUpdate: getHandler(handlers, "message_update"),
		messageEnd: getHandler(handlers, "message_end"),
		context: getHandler(handlers, "context"),
	}
}

/** Simulate streaming: message_start, then message_update per token, then message_end. */
async function simulateStreaming(h: Handlers, tokens: string[]) {
	const content = [{ type: "text" as const, text: "" }]
	const message = { role: "assistant" as const, content }

	await h.messageStart({ type: "message_start", message })
	for (const token of tokens) {
		content[0].text += token
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
	}
	const endResult = await h.messageEnd({ type: "message_end", message })
	return { message, content, endResult }
}

describe("hideThinkingExtension", () => {
	let h: Handlers

	beforeEach(() => {
		_resetState()
		h = setupExtension()
	})

	it("registers message_start, message_update, message_end, and context handlers", () => {
		const { handlers, api } = createMockApi()
		hideThinkingExtension(api)
		for (const event of ["message_start", "message_update", "message_end", "context"]) {
			expect(handlers.has(event), `missing handler for ${event}`).toBe(true)
		}
	})

	// --- Default behaviour (hideThinking = false → dim) ---

	it("dims thinking content by default (hideThinking not set)", async () => {
		const { endResult } = await simulateStreaming(h, ["Before ", "<think>", "reason", "</think>", " After"])
		expect(endResult).toBeDefined()
		const text = (endResult as { message: { content: Array<{ text: string }> } }).message.content[0].text
		expect(text).toBe(`Before ${fg(ANSI.dim, "reason")} After`)
	})

	// --- Explicit hideThinking = true (strip entirely) ---

	it("strips <think> tags from display when hideThinking is true", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Hello ", "<think>", "let me think...", "</think>", " World"])

		expect(endResult).toBeDefined()
		const text = (endResult as { message: { content: Array<{ text: string }> } }).message.content[0].text
		expect(text).toBe("Hello  World")
	})

	// --- Explicit hideThinking = false (dim, last 5 lines) ---

	it("shows only last 5 lines dimmed when hideThinking is false", async () => {
		_setHideThinking(false)

		const thinkingLines = Array.from({ length: 7 }, (_, i) => `Step ${i + 1}`)
		const { endResult } = await simulateStreaming(h, [
			"Before ",
			"<think>",
			thinkingLines.join("\n"),
			"</think>",
			" After",
		])

		expect(endResult).toBeDefined()
		const text = (endResult as { message: { content: Array<{ text: string }> } }).message.content[0].text
		const expected = thinkingLines.slice(-5).join("\n")
		expect(text).toBe(`Before ${fg(ANSI.dim, expected)} After`)
	})

	// --- Streaming display ---

	it("hides <think> tag and dims content during streaming", async () => {
		const content = [{ type: "text" as const, text: "" }]
		const message = { role: "assistant" as const, content }

		await h.messageStart({ type: "message_start", message })

		// Tokens before <think> — unmodified
		content[0].text += "Hello "
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// <think> tag arrives — should be hidden
		content[0].text += "<think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// Thinking content streams in — should be dimmed
		content[0].text += "reasoning"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "reasoning")}`)

		// </think> closes — content stays dimmed
		content[0].text += "</think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "reasoning")}`)

		// More text after closing
		content[0].text += " World"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "reasoning")} World`)
	})

	it("hides thinking content entirely during streaming when hideThinking is true", async () => {
		_setHideThinking(true)
		const content = [{ type: "text" as const, text: "" }]
		const message = { role: "assistant" as const, content }

		await h.messageStart({ type: "message_start", message })

		content[0].text += "Hello "
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// <think> tag arrives — hidden
		content[0].text += "<think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// Thinking content streams in — also hidden (not dimmed)
		content[0].text += "secret reasoning"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// </think> closes — still just "Hello "
		content[0].text += "</think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		// Text after closing is visible
		content[0].text += " World"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello  World")
	})

	// --- Context restoration round-trip ---

	it("restores original thinking content in context event after streaming", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Before ", "<think>", "deep reasoning", "</think>", " After"])
		const displayText = (endResult as { message: { content: Array<{ text: string }> } }).message.content[0].text
		expect(displayText).toBe("Before  After")

		// Simulate structuredClone (context event gets cloned messages)
		const contextResult = await h.context({
			type: "context",
			messages: [
				{ role: "user", content: [{ type: "text", text: "question" }] },
				{ role: "assistant", content: [{ type: "text", text: displayText }] },
			],
		})

		expect(contextResult).toBeDefined()
		const restored = (contextResult as { messages: Array<{ content: Array<{ text: string }> }> }).messages
		expect(restored[1].content[0].text).toBe("Before <think>deep reasoning</think> After")
		expect(restored[0].content[0].text).toBe("question")
	})

	it("populates shadow map for each transformed block", async () => {
		_setHideThinking(true)
		await simulateStreaming(h, ["A ", "<think>", "reasoning", "</think>", " B"])

		const map = _getDisplayToOriginal()
		expect(map.size).toBe(1)
		expect(map.get("A  B")).toBe("A <think>reasoning</think> B")
	})

	it("does not modify non-assistant messages", async () => {
		const result = await h.messageEnd({
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "<think>user typed this</think>" }],
			},
		})
		expect(result).toBeUndefined()
	})

	it("does not modify messages without think tags", async () => {
		const result = await h.messageEnd({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Hello World" }],
			},
		})
		expect(result).toBeUndefined()
	})

	it("does not touch native thinking content blocks", async () => {
		const result = await h.messageEnd({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Hello" },
					{ type: "thinking", thinking: "Let me think..." },
					{ type: "text", text: " World" },
				],
			},
		})
		expect(result).toBeUndefined()
	})

	it("handles multiple think blocks in one text block", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, [
			"A ",
			"<think>",
			"first",
			"</think>",
			" B ",
			"<think>",
			"second",
			"</think>",
			" C",
		])

		expect(endResult).toBeDefined()
		const text = (endResult as { message: { content: Array<{ text: string }> } }).message.content[0].text
		expect(text).toBe("A  B  C")
	})

	it("context handler is a no-op when shadow map is empty", async () => {
		const result = await h.context({
			type: "context",
			messages: [{ role: "assistant", content: [{ type: "text", text: "plain text" }] }],
		})
		expect(result).toBeUndefined()
	})
})

describe("filterThinkingForDisplay", () => {
	beforeEach(() => {
		_resetState()
	})

	const cases: Record<string, { input: string; hideThinking: boolean; expected: string }> = {
		"strips thinking blocks when hideThinking is true": {
			input: "Before <think>reasoning</think> After",
			hideThinking: true,
			expected: "Before  After",
		},
		"dims thinking blocks when hideThinking is false": {
			input: "Before <think>reasoning</think> After",
			hideThinking: false,
			expected: `Before ${fg(ANSI.dim, "reasoning")} After`,
		},
		"returns text unchanged when no thinking tags present": {
			input: "plain text without thinking",
			hideThinking: true,
			expected: "plain text without thinking",
		},
		"handles multiple thinking blocks": {
			input: "A <think>first</think> B <think>second</think> C",
			hideThinking: true,
			expected: "A  B  C",
		},
		"handles unclosed think tag by hiding trailing content when hideThinking is true": {
			input: "Before <think>still streaming",
			hideThinking: true,
			expected: "Before ",
		},
		"handles unclosed think tag by dimming trailing content when hideThinking is false": {
			input: "Before <think>still streaming",
			hideThinking: false,
			expected: `Before ${fg(ANSI.dim, "still streaming")}`,
		},
	}

	for (const [name, { input, hideThinking, expected }] of Object.entries(cases)) {
		it(name, () => {
			_setHideThinking(hideThinking)
			expect(filterThinkingForDisplay(input)).toBe(expected)
		})
	}
})
