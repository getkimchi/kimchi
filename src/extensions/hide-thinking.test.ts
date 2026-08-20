import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ANSI, fg } from "../ansi.js"
import hideThinkingExtension, {
	_getDisplayToOriginal,
	_resetState,
	_setHideThinking,
	filterThinkingForDisplay,
	isHideThinkingEnabled,
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

interface TextMessage {
	role: string
	content: Array<{ type: string; text: string }>
}

interface MessageEndResult {
	message: TextMessage
}

function getText(result: MessageEndResult | undefined): string {
	if (!result) throw new Error("expected message_end result")
	return result.message.content[0].text
}

function getContextText(result: unknown, index = 0): string {
	if (!result || typeof result !== "object" || !("messages" in result)) {
		throw new Error("expected context result")
	}
	const messages = (result as { messages: TextMessage[] }).messages
	return messages[index].content[0].text
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
	const endResult = (await h.messageEnd({ type: "message_end", message })) as MessageEndResult | undefined
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

	it("hides thinking by default when settings.json is missing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-hide-thinking-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", tempDir)
		try {
			_resetState()
			expect(isHideThinkingEnabled()).toBe(true)
		} finally {
			vi.unstubAllEnvs()
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("hides thinking when settings.json exists without hideThinkingBlock key", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-hide-thinking-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", tempDir)
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ statusLine: { pinned: [] } }))
		try {
			_resetState()
			expect(isHideThinkingEnabled()).toBe(true)
		} finally {
			vi.unstubAllEnvs()
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	it("dims thinking when hideThinkingBlock is false in settings.json", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-hide-thinking-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", tempDir)
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ hideThinkingBlock: false }))
		try {
			_resetState()
			expect(isHideThinkingEnabled()).toBe(false)
		} finally {
			vi.unstubAllEnvs()
			rmSync(tempDir, { recursive: true, force: true })
		}
	})

	// --- Explicit hideThinking = false (dim) ---

	it("dims thinking content when hideThinking is false", async () => {
		_setHideThinking(false)
		const { endResult } = await simulateStreaming(h, ["Before ", "<think>", "reason", "</think>", " After"])
		expect(endResult).toBeDefined()
		const text = getText(endResult)
		expect(text).toBe(`Before ${fg(ANSI.dim, "reason")}\n\n After`)
	})

	// --- Explicit hideThinking = true (strip entirely) ---

	it("strips <think> tags from display when hideThinking is true", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Hello ", "<think>", "let me think...", "</think>", " World"])

		expect(endResult).toBeDefined()
		const text = getText(endResult)
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
		const text = getText(endResult)
		const expectedLines = thinkingLines.slice(-5)
		const expectedDimmed = expectedLines.map((l) => fg(ANSI.dim, l)).join("\n")
		expect(text).toBe(`Before ${expectedDimmed}\n\n After`)
	})

	// --- Streaming display ---

	it("hides <think> tag and dims content during streaming", async () => {
		_setHideThinking(false)
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
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "reasoning")}\n\n World`)
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
		const displayText = getText(endResult)
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
		expect(getContextText(contextResult, 1)).toBe("Before <think>deep reasoning</think> After")
		expect(getContextText(contextResult)).toBe("question")
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
		const text = getText(endResult)
		expect(text).toBe("A  B  C")
	})

	// --- <thinking> tags ---

	it("strips <thinking> blocks when hideThinking is true (streaming)", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, [
			"Before ",
			"<thinking>",
			"long reasoning",
			"</thinking>",
			" After",
		])
		expect(endResult).toBeDefined()
		const text = getText(endResult)
		expect(text).toBe("Before  After")
	})

	it("dims <thinking> content when hideThinking is false (streaming)", async () => {
		_setHideThinking(false)
		const { endResult } = await simulateStreaming(h, ["Before ", "<thinking>", "long reason", "</thinking>", " After"])
		expect(endResult).toBeDefined()
		const text = getText(endResult)
		expect(text).toBe(`Before ${fg(ANSI.dim, "long reason")}\n\n After`)
	})

	it("hides <thinking> tag and dims content during streaming", async () => {
		_setHideThinking(false)
		const content = [{ type: "text" as const, text: "" }]
		const message = { role: "assistant" as const, content }

		await h.messageStart({ type: "message_start", message })

		content[0].text += "Hello "
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		content[0].text += "<thinking>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		content[0].text += "long reasoning"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "long reasoning")}`)

		content[0].text += "</thinking>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "long reasoning")}`)

		content[0].text += " World"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "long reasoning")}\n\n World`)
	})

	it("restores <thinking> content in context event", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Before ", "<thinking>", "long deep", "</thinking>", " After"])
		const displayText = getText(endResult)
		expect(displayText).toBe("Before  After")

		const contextResult = await h.context({
			type: "context",
			messages: [{ role: "assistant", content: [{ type: "text", text: displayText }] }],
		})

		expect(contextResult).toBeDefined()
		expect(getContextText(contextResult)).toBe("Before <thinking>long deep</thinking> After")
	})

	it("hides trailing content when <thinking> is never closed (hideThinking is true)", async () => {
		_setHideThinking(true)
		const content = [{ type: "text" as const, text: "" }]
		const message = { role: "assistant" as const, content }

		await h.messageStart({ type: "message_start", message })
		content[0].text += "Before "
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		content[0].text += "<thinking>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		content[0].text += "never closed"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Before ")

		// An unclosed tag is not a closed thinking pair, so message_end returns
		// undefined; the streamed text was already truncated above.
		const endResult = await h.messageEnd({ type: "message_end", message })
		expect(endResult).toBeUndefined()
		expect(content[0].text).toBe("Before ")
	})

	// --- orphaned close tags (kimi-k2.x thinking=off fragments) ---

	// Mirrored from a real session (kimchi-session-…01a01465.html): kimi-k2.7
	// with thinkingLevel=off streams reasoning as plain text terminated by
	// </think> with no opening tag. Regression: the raw close tag leaked into
	// the TUI because every gate required a balanced open+close pair.

	it("strips trailing orphan </think> with no opener (hideThinking is true)", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["reasoning text", "</think>"])
		const display = getText(endResult)
		expect(display).toBe("reasoning text")
	})

	it("strips leading and trailing orphan </think> (hideThinking is true)", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["</think>Need to describe", " the branch.", "</think>"])
		const display = getText(endResult)
		expect(display).toBe("Need to describe the branch.")
	})

	it("strips leading orphan </think> from final answer (hideThinking is true)", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["</think>Current branch: ", "fix/foo"])
		const display = getText(endResult)
		expect(display).toBe("Current branch: fix/foo")
	})

	it("strips orphan close tags when hideThinking is false", async () => {
		_setHideThinking(false)
		const { endResult } = await simulateStreaming(h, ["</think>answer"])
		const display = getText(endResult)
		expect(display).toBe("answer")
	})

	it("does not strip close tags that belong to balanced blocks", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["A <think>hidden</think> B </think> C"])
		const display = getText(endResult)
		expect(display).toBe("A  B  C")
	})

	it("strips chunked orphan </think> arriving char by char", async () => {
		_setHideThinking(true)
		const { content, endResult } = await simulateStreaming(h, ["plan", "</t", "hi", "nk>"])
		// message_end transforms the full original and returns the display text
		const display = endResult?.message.content[0].text ?? content[0].text
		expect(display).toBe("plan")
	})

	it("strips orphan </thinking> and </mm:think> close tags", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["</thinking>middle </mm:think> end"])
		const display = getText(endResult)
		expect(display).toBe("middle  end")
	})

	// --- mm:think tags ---

	it("dims <mm:think> content when hideThinking is false", async () => {
		_setHideThinking(false)
		const { endResult } = await simulateStreaming(h, ["Before ", "<mm:think>", "mm reason", "</mm:think>", " After"])
		expect(endResult).toBeDefined()
		const text = getText(endResult)
		expect(text).toBe(`Before ${fg(ANSI.dim, "mm reason")}\n\n After`)
	})

	it("strips <mm:think> tags when hideThinking is true", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Hello ", "<mm:think>", "mm reasoning", "</mm:think>", " World"])
		expect(endResult).toBeDefined()
		const text = getText(endResult)
		expect(text).toBe("Hello  World")
	})

	it("hides <mm:think> tag and dims content during streaming", async () => {
		_setHideThinking(false)
		const content = [{ type: "text" as const, text: "" }]
		const message = { role: "assistant" as const, content }

		await h.messageStart({ type: "message_start", message })

		content[0].text += "Hello "
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		content[0].text += "<mm:think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe("Hello ")

		content[0].text += "mm reasoning"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "mm reasoning")}`)

		content[0].text += "</mm:think>"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "mm reasoning")}`)

		content[0].text += " World"
		await h.messageUpdate({ type: "message_update", message, assistantMessageEvent: {} })
		expect(content[0].text).toBe(`Hello ${fg(ANSI.dim, "mm reasoning")}\n\n World`)
	})

	it("restores <mm:think> content in context event", async () => {
		_setHideThinking(true)
		const { endResult } = await simulateStreaming(h, ["Before ", "<mm:think>", "mm deep", "</mm:think>", " After"])
		const displayText = getText(endResult)
		expect(displayText).toBe("Before  After")

		const contextResult = await h.context({
			type: "context",
			messages: [{ role: "assistant", content: [{ type: "text", text: displayText }] }],
		})

		expect(contextResult).toBeDefined()
		expect(getContextText(contextResult)).toBe("Before <mm:think>mm deep</mm:think> After")
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
			expected: `Before ${fg(ANSI.dim, "reasoning")}\n\n After`,
		},
		"returns text unchanged when no thinking tags present": {
			input: "plain text without thinking",
			hideThinking: true,
			expected: "plain text without thinking",
		},
		"strips empty thinking tags": {
			input: "Before <thinking></thinking> After",
			hideThinking: true,
			expected: "Before  After",
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
		"strips mm:think blocks when hideThinking is true": {
			input: "Before <mm:think>mm reasoning</mm:think> After",
			hideThinking: true,
			expected: "Before  After",
		},
		"dims mm:think blocks when hideThinking is false": {
			input: "Before <mm:think>mm reasoning</mm:think> After",
			hideThinking: false,
			expected: `Before ${fg(ANSI.dim, "mm reasoning")}\n\n After`,
		},
		"handles unclosed mm:think tag by hiding content when hideThinking is true": {
			input: "Before <mm:think>still streaming",
			hideThinking: true,
			expected: "Before ",
		},
		"handles unclosed mm:think tag by dimming content when hideThinking is false": {
			input: "Before <mm:think>still streaming",
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
