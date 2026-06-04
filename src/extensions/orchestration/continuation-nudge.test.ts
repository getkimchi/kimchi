import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	ContinuationNudge,
	DONE_SIGNAL,
	EmptyTurnNudge,
	type OrchestratorMessages,
	stripStaleNudges,
	stripUiOnlyMessages,
} from "./continuation-nudge.js"

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "kimi-k2.5",
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

const textOnlyMessage = makeAssistant([{ type: "text", text: "I will delegate this to Nemotron." }])

const toolCallMessage = makeAssistant([
	{
		type: "toolCall",
		id: "call_1",
		name: "Agent",
		arguments: { model: "kimchi-dev/nemotron-3-super-fp4", subagent_type: "General-Purpose", prompt: "build it" },
	},
])

const textAndToolCallMessage = makeAssistant([
	{ type: "text", text: "Delegating now." },
	{
		type: "toolCall",
		id: "call_2",
		name: "Agent",
		arguments: { model: "kimchi-dev/nemotron-3-super-fp4", subagent_type: "General-Purpose", prompt: "build it" },
	},
])

const emptyTextMessage = makeAssistant([{ type: "text", text: "" }])
const whitespaceTextMessage = makeAssistant([{ type: "text", text: "   \n  " }])

describe("ContinuationNudge.evaluateTurn", () => {
	it("nudges a text-only first turn after user input", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})

	it("does not nudge when the turn contains a tool call", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(toolCallMessage)).toBe(false)
	})

	it("does not nudge when the turn has both text and a tool call", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textAndToolCallMessage)).toBe(false)
	})

	it("does not nudge when the turn has no text at all", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(makeAssistant([]))).toBe(false)
	})

	it("treats empty-string text as no text", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(emptyTextMessage)).toBe(false)
	})

	it("treats whitespace-only text as no text", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(whitespaceTextMessage)).toBe(false)
	})

	it("nudges at most twice per user-input cycle", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("does not nudge when any tool has already been called this cycle", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.recordToolCall()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("re-arms after a new user input", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})

	it("re-arms tool-call tracking on reset", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.recordToolCall()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})

	it("sets nudge response pending after nudging", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.isNudgeResponsePending()).toBe(false)
		guard.evaluateTurn(textOnlyMessage)
		expect(guard.isNudgeResponsePending()).toBe(true)
	})

	it("clears nudge response pending when a tool call is recorded", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.evaluateTurn(textOnlyMessage)
		expect(guard.isNudgeResponsePending()).toBe(true)
		guard.recordToolCall()
		expect(guard.isNudgeResponsePending()).toBe(false)
	})

	it("clears nudge response pending on reset", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.evaluateTurn(textOnlyMessage)
		expect(guard.isNudgeResponsePending()).toBe(true)
		guard.resetForNewUserInput()
		expect(guard.isNudgeResponsePending()).toBe(false)
	})

	it("ignores thinking-only turns (no text, no tool call)", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		const thinkingOnly = makeAssistant([{ type: "thinking", thinking: "Let me reason..." }])
		expect(guard.evaluateTurn(thinkingOnly)).toBe(false)
	})
})

describe("ContinuationNudge.isDoneSignalReceived", () => {
	it("returns false when no response has been accumulated", () => {
		const guard = new ContinuationNudge()
		expect(guard.isDoneSignalReceived()).toBe(false)
	})

	it("returns true when accumulated text equals the done signal", () => {
		const guard = new ContinuationNudge()
		guard.accumulateResponse(DONE_SIGNAL)
		expect(guard.isDoneSignalReceived()).toBe(true)
	})

	it("returns true when accumulated text equals done signal with surrounding whitespace", () => {
		const guard = new ContinuationNudge()
		guard.accumulateResponse("  ")
		guard.accumulateResponse(DONE_SIGNAL)
		guard.accumulateResponse("\n")
		expect(guard.isDoneSignalReceived()).toBe(true)
	})

	it("returns false when accumulated text is not the done signal", () => {
		const guard = new ContinuationNudge()
		guard.accumulateResponse("I am done.")
		expect(guard.isDoneSignalReceived()).toBe(false)
	})

	it("clears accumulated response on reset", () => {
		const guard = new ContinuationNudge()
		guard.accumulateResponse(DONE_SIGNAL)
		guard.resetForNewUserInput()
		expect(guard.isDoneSignalReceived()).toBe(false)
	})

	it("clears accumulated response when a tool call is recorded", () => {
		const guard = new ContinuationNudge()
		guard.accumulateResponse(DONE_SIGNAL)
		guard.recordToolCall()
		expect(guard.isDoneSignalReceived()).toBe(false)
	})
})

describe("ContinuationNudge nudge-response-pending state", () => {
	it("marks nudge response pending after evaluateTurn fires", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		expect(guard.isNudgeResponsePending()).toBe(false)
		guard.evaluateTurn(textOnlyMessage)
		expect(guard.isNudgeResponsePending()).toBe(true)
	})

	it("remains pending when model responds without tool calls (handler must check stopReason)", () => {
		// After a nudge fires and the model responds with text-only (no <done>),
		// isNudgeResponsePending() stays true because recordToolCall() is never
		// called. The turn_end handler in prompt-enrichment.ts checks stopReason
		// to decide whether to honour the stop or send another nudge.
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.evaluateTurn(textOnlyMessage) // first nudge fires
		expect(guard.isNudgeResponsePending()).toBe(true)
		// Model responds with text but not <done>; no tool calls recorded.
		guard.accumulateResponse("I am done with the task.")
		expect(guard.isNudgeResponsePending()).toBe(true)
		expect(guard.isDoneSignalReceived()).toBe(false)
		// At this point the handler checks stopReason === "stop" to break
		// the nudge cycle instead of falling through to evaluateTurn again.
	})

	it("clears pending state when model calls a tool after nudge", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.evaluateTurn(textOnlyMessage) // nudge fires
		expect(guard.isNudgeResponsePending()).toBe(true)
		guard.recordToolCall() // model obeyed the nudge
		expect(guard.isNudgeResponsePending()).toBe(false)
	})
})

describe("ContinuationNudge Agent-pending suppression", () => {
	it("suppresses the nudge when an Agent call is pending", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.markDelegationCall()
		// Even though this is a text-only turn, the nudge must not fire
		// because an Agent result is still pending.
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("allows the nudge after clearDelegationPending is called", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.markDelegationCall()
		guard.clearDelegationPending()
		// Now the nudge can fire normally.
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})

	it("resetForNewUserInput does NOT clear pending delegation count", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.markDelegationCall()
		// Simulate an unrelated user input arriving while an Agent is running.
		guard.resetForNewUserInput()
		// The nudge must still be suppressed — we are still waiting for the result.
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("a regular tool call does NOT clear pending delegation count", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.markDelegationCall()
		// Model makes a regular non-Agent tool call — delegation is still pending.
		guard.recordToolCall()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("multiple markDelegationCall requires matching clearDelegationPending calls", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.markDelegationCall()
		guard.markDelegationCall() // two concurrent Agents
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
		// First result arrives — still one pending.
		guard.clearDelegationPending()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
		// Second result arrives — all done, nudge can fire.
		guard.clearDelegationPending()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})

	it("clearDelegationPending without markDelegationCall has no effect", () => {
		const guard = new ContinuationNudge()
		guard.resetForNewUserInput()
		guard.clearDelegationPending()
		// Normal behavior: nudge fires on text-only turn.
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(true)
	})
})

function makeUser(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function makeNudge(): OrchestratorMessages[number] {
	return {
		role: "custom" as const,
		customType: "nudge",
		content: [{ type: "text" as const, text: "nudge" }],
		display: false,
		timestamp: Date.now(),
	}
}

describe("stripStaleNudges", () => {
	it("returns the same array when there are no nudge messages", () => {
		const messages: OrchestratorMessages = [makeUser("q"), textOnlyMessage]
		expect(stripStaleNudges(messages)).toBe(messages)
	})

	it("strips a nudge that precedes an assistant response", () => {
		const nudge = makeNudge()
		const messages: OrchestratorMessages = [makeUser("q"), nudge, textOnlyMessage]
		const result = stripStaleNudges(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(2)
		expect(result).not.toContainEqual(nudge)
	})

	it("keeps a nudge that comes after the last assistant message", () => {
		const nudge = makeNudge()
		const messages: OrchestratorMessages = [makeUser("q"), textOnlyMessage, nudge]
		const result = stripStaleNudges(messages)
		expect(result).toBe(messages)
	})

	it("strips multiple stale nudges", () => {
		const messages: OrchestratorMessages = [
			makeUser("q1"),
			makeNudge(),
			textOnlyMessage,
			makeUser("q2"),
			makeNudge(),
			toolCallMessage,
		]
		const result = stripStaleNudges(messages)
		expect(result.filter((m) => m.role === "custom")).toHaveLength(0)
	})

	it("does not strip non-nudge custom messages", () => {
		const other = { role: "custom" as const, customType: "other", content: "x", display: false, timestamp: Date.now() }
		const messages: OrchestratorMessages = [makeUser("q"), other, textOnlyMessage]
		const result = stripStaleNudges(messages)
		expect(result).toContainEqual(other)
	})
})

describe("EmptyTurnNudge", () => {
	const emptyMessage = makeAssistant([])
	const whitespaceOnlyMessage = makeAssistant([{ type: "text", text: "   \n  " }])

	it("nudges when an empty turn follows a tool-call-only turn", () => {
		const guard = new EmptyTurnNudge()
		guard.evaluateTurn(toolCallMessage)
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
	})

	it("nudges on an empty first turn (no preceding turn at all)", () => {
		const guard = new EmptyTurnNudge()
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
	})

	it("nudges on an empty turn after a text-only turn", () => {
		const guard = new EmptyTurnNudge()
		guard.evaluateTurn(textOnlyMessage)
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
	})

	it("nudges on an empty turn after a text-and-tool-call turn", () => {
		const guard = new EmptyTurnNudge()
		guard.evaluateTurn(textAndToolCallMessage)
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
	})

	it("treats whitespace-only text as empty", () => {
		const guard = new EmptyTurnNudge()
		guard.evaluateTurn(toolCallMessage)
		expect(guard.evaluateTurn(whitespaceOnlyMessage)).toBe(true)
	})

	it("does not nudge on a tool-call turn itself", () => {
		const guard = new EmptyTurnNudge()
		expect(guard.evaluateTurn(toolCallMessage)).toBe(false)
	})

	it("does not nudge on a text-only turn", () => {
		const guard = new EmptyTurnNudge()
		expect(guard.evaluateTurn(textOnlyMessage)).toBe(false)
	})

	it("resets tracking after two nudges", () => {
		const guard = new EmptyTurnNudge()
		guard.evaluateTurn(toolCallMessage)
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
		expect(guard.evaluateTurn(emptyMessage)).toBe(false)
	})

	it("re-arms after resetForNewUserInput", () => {
		const guard = new EmptyTurnNudge()
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
		// Already nudged twice this cycle — third empty should not nudge
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
		expect(guard.evaluateTurn(emptyMessage)).toBe(false)
		// Reset re-arms the nudge for the next user-input cycle
		guard.resetForNewUserInput()
		expect(guard.evaluateTurn(emptyMessage)).toBe(true)
	})
})

describe("stripUiOnlyMessages", () => {
	function makeUiOnly(customType: string): OrchestratorMessages[number] {
		return {
			role: "custom",
			customType,
			content: [{ type: "text", text: "ui-only" }],
			display: true,
			timestamp: Date.now(),
		}
	}

	it("returns the same array when there are no UI-only messages", () => {
		const messages: OrchestratorMessages = [makeUser("q"), textOnlyMessage]
		expect(stripUiOnlyMessages(messages)).toBe(messages)
	})

	it("strips a UI-only message from the tail", () => {
		const ui = makeUiOnly("prompt-summary")
		const messages: OrchestratorMessages = [makeUser("q"), textOnlyMessage, ui]
		const result = stripUiOnlyMessages(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(2)
		expect(result).not.toContainEqual(ui)
	})

	it("strips a UI-only message from the middle", () => {
		const ui = makeUiOnly("ferment_breadcrumb")
		const messages: OrchestratorMessages = [makeUser("q"), ui, textOnlyMessage]
		const result = stripUiOnlyMessages(messages)
		expect(result).not.toBe(messages)
		expect(result).toHaveLength(2)
		expect(result).not.toContainEqual(ui)
	})

	it("strips multiple distinct UI-only types", () => {
		const messages: OrchestratorMessages = [
			makeUser("q"),
			makeUiOnly("prompt-summary"),
			makeUser("q2"),
			makeUiOnly("curator-notification"),
			makeUiOnly("ferment_ack"),
			textOnlyMessage,
		]
		const result = stripUiOnlyMessages(messages)
		expect(result.filter((m) => m.role === "custom")).toHaveLength(0)
		expect(result).toHaveLength(3)
	})

	it("does not strip non-UI custom messages", () => {
		const other = {
			role: "custom" as const,
			customType: "subagent-notification",
			content: [{ type: "text" as const, text: "agent done" }],
			display: true,
			timestamp: Date.now(),
		}
		const messages: OrchestratorMessages = [makeUser("q"), other, textOnlyMessage]
		const result = stripUiOnlyMessages(messages)
		expect(result).toBe(messages)
	})
})
