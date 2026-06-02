import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import llmResponseLogExtension from "./llm-response-log.js"

// ── helpers ──────────────────────────────────────────────────────────────────

type MessageEndEvent = {
	message: {
		role: string
		model: string
		provider: string
		api: string
		stopReason: string
		errorMessage?: string
		content: Array<{ type: string; [key: string]: unknown }>
		usage: {
			input: number
			output: number
			cacheRead: number
			cacheWrite: number
			totalTokens: number
			cost: {
				input: number
				output: number
				cacheRead: number
				cacheWrite: number
				total: number
			}
		}
		timestamp: number
	}
}

function makeMockPI() {
	const handlers: Array<(event: MessageEndEvent) => unknown> = []
	const appendEntryMock = vi.fn()

	const pi = {
		on(event: string, handler: (event: MessageEndEvent) => unknown) {
			if (event === "message_end") {
				handlers.push(handler)
			}
		},
		appendEntry: appendEntryMock,
	} as unknown as ExtensionAPI & { appendEntry: typeof appendEntryMock }

	async function trigger(event: string, payload: MessageEndEvent) {
		for (const handler of handlers) {
			await handler(payload)
		}
	}

	return { pi, trigger, appendEntryMock, getAppendEntryMock: () => appendEntryMock }
}

function makeAssistantMessage(overrides: Partial<MessageEndEvent["message"]> = {}): MessageEndEvent["message"] {
	return {
		role: "assistant",
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		api: "messages",
		stopReason: "end_turn",
		content: [{ type: "text", text: "Hello!" }],
		usage: {
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 155,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
		},
		timestamp: 0,
		...overrides,
	}
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("llmResponseLogExtension", () => {
	it("happy path: logs assistant message with text and tool calls", async () => {
		const { pi, trigger, appendEntryMock } = makeMockPI()
		llmResponseLogExtension(pi)

		const before = Date.now()
		await trigger("message_end", {
			message: makeAssistantMessage({
				model: "claude-sonnet-4-20250514",
				provider: "anthropic",
				api: "messages",
				stopReason: "end_turn",
				content: [
					{ type: "text", text: "I'll read the file for you." },
					{ type: "toolCall", name: "read", id: "tool-1", arguments: { path: "src/index.ts" } },
					{ type: "toolCall", name: "bash", id: "tool-2", arguments: { command: "ls" } },
				],
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 155,
					cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
				},
			}),
		})
		const after = Date.now()

		expect(appendEntryMock).toHaveBeenCalledTimes(1)
		const [customType, data] = appendEntryMock.mock.calls[0]

		expect(customType).toBe("llm_response_debug")
		expect(data).toMatchObject({
			model: "claude-sonnet-4-20250514",
			provider: "anthropic",
			api: "messages",
			stopReason: "end_turn",
		})
		expect(data.toolCalls).toEqual([
			{ name: "read", id: "tool-1", arguments: { path: "src/index.ts" } },
			{ name: "bash", id: "tool-2", arguments: { command: "ls" } },
		])
		expect(data.contentSummary).toEqual(["text", "toolCall", "toolCall"])
		expect(data.usage).toEqual({
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 155,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
		})
		expect(data.timestamp).toBeGreaterThanOrEqual(before)
		expect(data.timestamp).toBeLessThanOrEqual(after)
	})

	it("assistant message without tool calls logs empty toolCalls array", async () => {
		const { pi, trigger, appendEntryMock } = makeMockPI()
		llmResponseLogExtension(pi)

		await trigger("message_end", {
			message: makeAssistantMessage({
				content: [{ type: "text", text: "Hello, how can I help?" }],
			}),
		})

		expect(appendEntryMock).toHaveBeenCalledTimes(1)
		const [, data] = appendEntryMock.mock.calls[0]

		expect(data.toolCalls).toEqual([])
		expect(data.contentSummary).toEqual(["text"])
	})

	it("non-assistant messages are ignored", async () => {
		const { pi, trigger, appendEntryMock } = makeMockPI()
		llmResponseLogExtension(pi)

		await trigger("message_end", {
			message: {
				role: "user",
				model: "claude-sonnet-4-20250514",
				provider: "anthropic",
				api: "messages",
				stopReason: "end_turn",
				content: [{ type: "text", text: "Hello!" }],
				usage: {
					input: 100,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 100,
					cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
				},
				timestamp: 0,
			},
		})

		expect(appendEntryMock).not.toHaveBeenCalled()
	})

	it("error handling: appendEntry throws does not propagate and logs error", async () => {
		const { pi, trigger } = makeMockPI()
		llmResponseLogExtension(pi)

		// Replace appendEntry with a throwing mock after extension is registered
		;(pi as unknown as { appendEntry: () => void }).appendEntry = () => {
			throw new Error("appendEntry failed")
		}

		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// Should not throw
		await expect(
			trigger("message_end", {
				message: makeAssistantMessage(),
			}),
		).resolves.not.toThrow()

		expect(consoleErrorSpy).toHaveBeenCalledWith("[llm-response-log] failed to append debug entry:", expect.any(Error))
		consoleErrorSpy.mockRestore()
	})
})
