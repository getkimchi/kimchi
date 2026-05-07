import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai"
import { describe, expect, it } from "vitest"
import type { OrchestratorMessages } from "./continuation-nudge.js"
import { EnrichmentGuard, deduplicateEnrichedPrompts, stripEmptyToolCalls } from "./prompt-enrichment.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnrichedPrompt(): OrchestratorMessages[number] {
	return {
		role: "custom" as const,
		customType: "enriched-prompt",
		content: [{ type: "text" as const, text: "## Your Capabilities\n..." }],
		display: false,
		timestamp: Date.now(),
	}
}

function makeUser(text: string): OrchestratorMessages[number] {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function makeAssistant(content: AssistantMessage["content"] = [{ type: "text", text: "Done." }]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "kimchi-dev",
		model: "kimi-k2.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function makeToolResult(toolCallId: string, text = "Tool  not found", isError = true): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "",
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		timestamp: Date.now(),
	}
}

// ---------------------------------------------------------------------------
// EnrichmentGuard
// ---------------------------------------------------------------------------

describe("EnrichmentGuard", () => {
	it("injects on the first turn (no model seen yet)", () => {
		const guard = new EnrichmentGuard()
		expect(guard.shouldEnrich("kimi-k2.6")).toBe(true)
	})

	it("does not inject again on the same model", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		expect(guard.shouldEnrich("kimi-k2.6")).toBe(false)
	})

	it("does not inject on any subsequent turn with the same model", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		for (let i = 0; i < 5; i++) {
			expect(guard.shouldEnrich("kimi-k2.6")).toBe(false)
		}
	})

	it("re-injects when the model changes", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		expect(guard.shouldEnrich("claude-opus-4-7")).toBe(true)
	})

	it("does not re-inject on the turn after a model change", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		guard.shouldEnrich("claude-opus-4-7")
		expect(guard.shouldEnrich("claude-opus-4-7")).toBe(false)
	})

	it("re-injects if model switches back to a previously seen model", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		guard.shouldEnrich("claude-opus-4-7")
		expect(guard.shouldEnrich("kimi-k2.6")).toBe(true)
	})

	it("treats empty string model ID as a valid first-turn key", () => {
		const guard = new EnrichmentGuard()
		expect(guard.shouldEnrich("")).toBe(true)
		expect(guard.shouldEnrich("")).toBe(false)
	})

	it("re-injects after reset", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6")
		guard.reset()
		expect(guard.shouldEnrich("kimi-k2.6")).toBe(true)
	})

	it("re-injects when the phase changes with the same model", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", "explore")
		expect(guard.shouldEnrich("kimi-k2.6", "build")).toBe(true)
	})

	it("does not re-inject when neither model nor phase changes", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", "build")
		expect(guard.shouldEnrich("kimi-k2.6", "build")).toBe(false)
	})

	it("re-injects when both model and phase change simultaneously", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", "explore")
		expect(guard.shouldEnrich("claude-opus-4-7", "build")).toBe(true)
	})

	it("treats undefined phase as a stable key (no re-inject on repeated undefined)", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", undefined)
		expect(guard.shouldEnrich("kimi-k2.6", undefined)).toBe(false)
	})

	it("re-injects when phase transitions from undefined to a real phase", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", undefined)
		expect(guard.shouldEnrich("kimi-k2.6", "explore")).toBe(true)
	})

	it("reset clears both model and phase so next call always re-injects", () => {
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", "build")
		guard.reset()
		expect(guard.shouldEnrich("kimi-k2.6", "build")).toBe(true)
	})

	it("re-injects on new session start even when model and phase are identical to previous session", () => {
		// Simulates: session 1 ends on (modelA, explore); session_start fires and
		// calls reset(); session 2 first turn is (modelA, explore) — must re-inject.
		const guard = new EnrichmentGuard()
		guard.shouldEnrich("kimi-k2.6", "explore") // end of previous session
		guard.reset() // session_start
		expect(guard.shouldEnrich("kimi-k2.6", "explore")).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// deduplicateEnrichedPrompts  (safety-net for accumulated duplicates)
// ---------------------------------------------------------------------------

describe("deduplicateEnrichedPrompts", () => {
	it("returns the same array when there are no enriched-prompt messages", () => {
		const messages: OrchestratorMessages = [makeUser("hi"), makeAssistant()]
		expect(deduplicateEnrichedPrompts(messages)).toBe(messages)
	})

	it("returns the same array when there is exactly one enriched-prompt", () => {
		const messages: OrchestratorMessages = [makeEnrichedPrompt(), makeUser("hi"), makeAssistant()]
		expect(deduplicateEnrichedPrompts(messages)).toBe(messages)
	})

	it("keeps only the last enriched-prompt when duplicates exist", () => {
		const first = makeEnrichedPrompt()
		const second = makeEnrichedPrompt()
		const messages: OrchestratorMessages = [first, makeUser("q1"), makeAssistant(), second, makeUser("q2")]
		const result = deduplicateEnrichedPrompts(messages)
		expect(result).not.toContain(first)
		expect(result).toContain(second)
	})

	it("removes all but the last when many duplicates have accumulated", () => {
		const copies = [makeEnrichedPrompt(), makeEnrichedPrompt(), makeEnrichedPrompt(), makeEnrichedPrompt()]
		const messages: OrchestratorMessages = [
			copies[0],
			makeUser("q1"),
			makeAssistant(),
			copies[1],
			makeUser("q2"),
			makeAssistant(),
			copies[2],
			makeUser("q3"),
			makeAssistant(),
			copies[3],
			makeUser("q4"),
		]
		const result = deduplicateEnrichedPrompts(messages)
		const remaining = result.filter(
			(m) => m.role === "custom" && "customType" in m && (m as { customType: string }).customType === "enriched-prompt",
		)
		expect(remaining).toHaveLength(1)
		expect(remaining[0]).toBe(copies[3])
	})

	it("preserves all non-enriched-prompt messages", () => {
		const user1 = makeUser("q1")
		const assistant1 = makeAssistant()
		const user2 = makeUser("q2")
		const messages: OrchestratorMessages = [makeEnrichedPrompt(), user1, assistant1, makeEnrichedPrompt(), user2]
		const result = deduplicateEnrichedPrompts(messages)
		expect(result).toContain(user1)
		expect(result).toContain(assistant1)
		expect(result).toContain(user2)
	})

	it("does not remove non-enriched-prompt custom messages", () => {
		const nudge = {
			role: "custom" as const,
			customType: "nudge",
			content: "nudge",
			display: false,
			timestamp: Date.now(),
		}
		const messages: OrchestratorMessages = [makeEnrichedPrompt(), makeEnrichedPrompt(), nudge, makeUser("q")]
		const result = deduplicateEnrichedPrompts(messages)
		expect(result).toContain(nudge)
	})
})

// ---------------------------------------------------------------------------
// stripEmptyToolCalls
// ---------------------------------------------------------------------------

describe("stripEmptyToolCalls", () => {
	it("returns the same array reference when there are no empty tool calls", () => {
		const messages: OrchestratorMessages = [
			makeUser("hi"),
			makeAssistant([
				{ type: "text", text: "writing file" },
				{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content: "x" } },
			]),
		]
		expect(stripEmptyToolCalls(messages)).toBe(messages)
	})

	it("returns the same array reference for an empty messages list", () => {
		const messages: OrchestratorMessages = []
		expect(stripEmptyToolCalls(messages)).toBe(messages)
	})

	it("strips an empty-name tool call from an assistant message", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "toolCall", id: "call_1", name: "write", arguments: { path: "a.ts", content: "x" } },
				{ type: "text", text: "Valid" },
				{ type: "toolCall", id: "", name: "", arguments: {} },
				{ type: "text", text: " " },
			]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(1)
		const content = (result[0] as AssistantMessage).content
		expect(content).toHaveLength(3)
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
				expect((block as { name: string }).name).toBe("write")
			}
		}
	})

	it("removes the paired toolResult by toolCallId", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([{ type: "toolCall", id: "empty-1", name: "", arguments: {} }]),
			makeToolResult("empty-1"),
			makeUser("next"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).not.toBe(messages)
		// Both the assistant turn (which becomes empty after stripping) and the
		// orphaned toolResult should be gone, leaving only the user message.
		expect(result).toHaveLength(1)
		expect(result[0]).toBe(messages[2])
	})

	it("keeps the assistant message when only some blocks are stripped", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "text", text: "keep me" },
				{ type: "toolCall", id: "", name: "", arguments: {} },
			]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(1)
		const content = (result[0] as AssistantMessage).content
		expect(content).toHaveLength(1)
		expect(content[0]).toEqual({ type: "text", text: "keep me" })
	})

	it("drops an assistant message that becomes empty after stripping", () => {
		const messages: OrchestratorMessages = [
			makeUser("q"),
			makeAssistant([{ type: "toolCall", id: "", name: "", arguments: {} }]),
			makeUser("q2"),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(2)
		expect(result[0]).toBe(messages[0])
		expect(result[1]).toBe(messages[2])
	})

	it("treats whitespace-only names as empty", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([{ type: "toolCall", id: "ws-1", name: "   ", arguments: {} }]),
		]
		const result = stripEmptyToolCalls(messages)
		expect(result).toHaveLength(0)
	})

	it("does not strip toolResults that pair with valid (non-empty) tool calls", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "toolCall", id: "good-1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "empty-1", name: "", arguments: {} },
			]),
			makeToolResult("good-1", "output", false),
			makeToolResult("empty-1"),
		]
		const result = stripEmptyToolCalls(messages)
		// Assistant kept (with one block), good toolResult kept, empty toolResult dropped.
		expect(result).toHaveLength(2)
		const assistantContent = (result[0] as AssistantMessage).content
		expect(assistantContent).toHaveLength(1)
		expect((assistantContent[0] as { name: string }).name).toBe("bash")
		expect((result[1] as ToolResultMessage).toolCallId).toBe("good-1")
	})

	it("handles multiple empty tool calls across multiple assistant turns", () => {
		const messages: OrchestratorMessages = [
			makeAssistant([
				{ type: "text", text: "t1" },
				{ type: "toolCall", id: "e1", name: "", arguments: {} },
			]),
			makeToolResult("e1"),
			makeAssistant([
				{ type: "text", text: "t2" },
				{ type: "toolCall", id: "e2", name: "", arguments: {} },
			]),
			makeToolResult("e2"),
		]
		const result = stripEmptyToolCalls(messages)
		// Two assistant turns kept (with text blocks), both toolResults dropped.
		expect(result).toHaveLength(2)
		for (const msg of result) {
			expect((msg as AssistantMessage).role).toBe("assistant")
			expect((msg as AssistantMessage).content).toHaveLength(1)
		}
	})
})
