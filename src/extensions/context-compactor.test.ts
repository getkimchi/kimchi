import type { TextContent, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import contextCompactorExtension, { computeCutoff, pruneToolResult } from "./context-compactor.js"

// helpers
function makeToolResult(toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "id-1",
		toolName,
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		timestamp: 0,
	}
}

function makeUser() {
	return { role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 }
}

function makeAssistant() {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		model: "test",
		timestamp: 0,
	}
}

// ── computeCutoff ────────────────────────────────────────────────────────────

describe("computeCutoff", () => {
	const PROTECT_WINDOW = 4
	const MAX_PROTECTED_CHARS = 100

	it("returns 0 when messages fit within protected budget", () => {
		const messages = [makeUser(), makeAssistant(), makeToolResult("bash", "small"), makeUser()]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("returns 0 when array length <= PROTECT_WINDOW", () => {
		const messages = [makeToolResult("bash", "x".repeat(200))]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(0)
	})

	it("returns length-1 when tail message alone exceeds MAX_PROTECTED_CHARS (not 0)", () => {
		// bug: old guard returned 0, silently skipping compaction
		const messages = [
			makeToolResult("bash", "old"),
			makeToolResult("bash", "x".repeat(150)), // index 1 (last) overflows budget
		]
		// cutoff should be 1 (protect only last message), not 0
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(1)
	})

	it("cuts at PROTECT_WINDOW boundary when chars are small", () => {
		// 6 messages, PROTECT_WINDOW=4 → cutoff should be 2
		const messages = [
			makeToolResult("bash", "a"),
			makeToolResult("bash", "b"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", "c"),
			makeUser(),
		]
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(2)
	})

	it("cuts earlier when recent tool results exceed MAX_PROTECTED_CHARS", () => {
		// large output in the last 4 messages exceeds budget → cutoff forced earlier
		const bigOutput = "x".repeat(150) // > MAX_PROTECTED_CHARS=100
		const messages = [
			makeToolResult("bash", "old"),
			makeUser(),
			makeAssistant(),
			makeToolResult("bash", bigOutput), // index 3 — in protect zone, but exceeds budget
			makeUser(),
		]
		// walking back: index 4 (user, 0 chars), index 3 (toolResult, 150 chars → exceeds 100)
		// → cutoff = 4 (message at index 3 pushed out of protected zone)
		expect(computeCutoff(messages as ContextEvent["messages"], PROTECT_WINDOW, MAX_PROTECTED_CHARS)).toBe(4)
	})
})

// ── pruneToolResult ──────────────────────────────────────────────────────────

describe("pruneToolResult", () => {
	const MIN_PRUNE_CHARS = 10

	it("returns a new object (no mutation)", () => {
		const msg = makeToolResult("bash", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result).not.toBe(msg)
		expect(msg.content[0]).toHaveProperty("text", "x".repeat(20)) // original unchanged
	})

	it("replaces large text content with placeholder", () => {
		const msg = makeToolResult("bash", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.content[0]).toHaveProperty("type", "text")
		expect((result.content[0] as TextContent).text).toContain("[compacted: bash output")
	})

	it("leaves small text content untouched", () => {
		const msg = makeToolResult("bash", "tiny")
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect((result.content[0] as TextContent).text).toBe("tiny")
	})

	it("preserves non-text content blocks unchanged", () => {
		const msg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "id-1",
			toolName: "bash",
			content: [
				// biome-ignore lint/suspicious/noExplicitAny: image block not in TextContent union
				{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } } as any,
				{ type: "text", text: "x".repeat(20) },
			],
			details: undefined,
			isError: false,
			timestamp: 0,
		}
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.content[0]).toHaveProperty("type", "image") // untouched
		expect((result.content[1] as TextContent).text).toContain("[compacted")
	})

	it("truncates error output to last 2000 chars with header", () => {
		const longError = "e".repeat(5000)
		const msg = makeToolResult("bash", longError, true)
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		const text = (result.content[0] as TextContent).text
		expect(text).toContain("[compacted: bash error")
		expect(text).toContain("e".repeat(2000))
		expect(text.length).toBeLessThan(longError.length)
	})

	it("preserves all ToolResultMessage fields", () => {
		const msg = makeToolResult("read", "x".repeat(20))
		const result = pruneToolResult(msg, MIN_PRUNE_CHARS)
		expect(result.toolCallId).toBe(msg.toolCallId)
		expect(result.toolName).toBe(msg.toolName)
		expect(result.isError).toBe(msg.isError)
		expect(result.timestamp).toBe(msg.timestamp)
	})
})

// ── contextCompactorExtension (event wiring) ─────────────────────────────────

function makeMockPI() {
	const handlers: Record<string, (event: unknown) => Promise<unknown>> = {}
	const entries: Array<{ customType: string; data: unknown }> = []
	return {
		pi: {
			on(event: string, handler: (e: unknown) => Promise<unknown>) {
				handlers[event] = handler
			},
			appendEntry(customType: string, data: unknown) {
				entries.push({ customType, data })
			},
		} as unknown as ExtensionAPI,
		async trigger(event: string, payload: unknown) {
			return handlers[event]?.(payload)
		},
		entries,
	}
}

function makeMessageEndEvent(inputTokens: number) {
	return {
		message: {
			role: "assistant" as const,
			usage: {
				input: inputTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			content: [],
			model: "test",
			timestamp: 0,
		},
	}
}

describe("contextCompactorExtension", () => {
	it("returns undefined when below token threshold", async () => {
		const { pi, trigger } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(1_000))
		const result = await trigger("context", {
			messages: [makeToolResult("bash", "x".repeat(600))] as ContextEvent["messages"],
		})
		expect(result).toBeUndefined()
	})

	it("returns undefined when above threshold but nothing to prune (cutoff = 0)", async () => {
		const { pi, trigger } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))
		// 3 messages — fits within PROTECT_WINDOW=30, chars well under MAX_PROTECTED_CHARS
		const messages = [makeUser(), makeAssistant(), makeToolResult("bash", "small")]
		const result = await trigger("context", { messages: messages as ContextEvent["messages"] })
		expect(result).toBeUndefined()
	})

	it("prunes tool results before the cutoff when above threshold", async () => {
		const { pi, trigger } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))
		// 1 old tool result + 30 recent messages → cutoff = 1, index 0 is pruned
		const oldOutput = makeToolResult("bash", "x".repeat(600)) // > MIN_PRUNE_CHARS=500
		const recent = Array.from({ length: 30 }, makeUser)
		const messages = [oldOutput, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		const pruned = result.messages[0] as ToolResultMessage
		expect((pruned.content[0] as TextContent).text).toContain("[compacted: bash output")
	})

	it("passes non-tool-result messages through unchanged before cutoff", async () => {
		const { pi, trigger } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))
		const oldUser = makeUser()
		const recent = Array.from({ length: 30 }, makeUser)
		const messages = [oldUser, ...recent] as ContextEvent["messages"]
		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		// user message before cutoff is returned by reference (not cloned)
		expect(result.messages[0]).toBe(oldUser)
	})

	it("emits tool_result_pruning entry with correct counts when pruning fires", async () => {
		const { pi, trigger, entries } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))
		const oldOutput = makeToolResult("bash", "x".repeat(600)) // 600 chars, pruned to placeholder
		const recent = Array.from({ length: 30 }, makeUser)
		const messages = [oldOutput, ...recent] as ContextEvent["messages"]
		await trigger("context", { messages })
		expect(entries).toHaveLength(1)
		expect(entries[0].customType).toBe("tool_result_pruning")
		const data = entries[0].data as { prunedCount: number; totalCharsRemoved: number; cutoff: number }
		expect(data.prunedCount).toBe(1)
		expect(data.totalCharsRemoved).toBeGreaterThan(0)
		expect(data.cutoff).toBe(1)
	})

	it("extends the protected window to include the most recent user message", async () => {
		const { pi, trigger, entries } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))

		// oldTool (index 0) is prunable, userMsg (index 1) must be preserved,
		// and 30 tool results (indices 2-31) fill the protected window.
		// baseCutoff = 2 would drop userMsg; floor brings it down to 1.
		const oldTool = makeToolResult("bash", "x".repeat(600))
		const userMsg = makeUser()
		const recent = Array.from({ length: 30 }, () => makeToolResult("bash", "x".repeat(600)))
		const messages = [oldTool, userMsg, ...recent] as ContextEvent["messages"]

		const result = (await trigger("context", { messages })) as { messages: ContextEvent["messages"] }
		expect(result).toBeDefined()
		expect(result.messages[1]).toBe(userMsg) // user message preserved
		expect(entries).toHaveLength(1)
		const data = entries[0].data as { cutoff: number }
		expect(data.cutoff).toBe(1)
	})

	it("does not emit entry when no messages are actually pruned", async () => {
		const { pi, trigger, entries } = makeMockPI()
		contextCompactorExtension(pi)
		await trigger("message_end", makeMessageEndEvent(40_000))
		// old tool result is below MIN_PRUNE_CHARS — won't be pruned
		const oldOutput = makeToolResult("bash", "tiny")
		const recent = Array.from({ length: 30 }, makeUser)
		const messages = [oldOutput, ...recent] as ContextEvent["messages"]
		await trigger("context", { messages })
		expect(entries).toHaveLength(0)
	})
})
