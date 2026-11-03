import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import type { CustomEntry, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { deriveRatingState } from "./rating-state.js"

// Entry builders. Only the fields the derivation reads carry meaningful
// values; the rest satisfy the persisted shapes.
let seq = 0
function nextId(): string {
	seq += 1
	return `id${String(seq).padStart(7, "0")}`
}

function base() {
	return { id: nextId(), parentId: null, timestamp: "2026-10-26T00:00:00.000Z" }
}

function messageEntry(message: UserMessage | AssistantMessage | ToolResultMessage): SessionEntry {
	const entry: SessionMessageEntry = { type: "message", message, ...base() }
	return entry
}

function customEntry(customType: string, data: unknown): SessionEntry {
	const entry: CustomEntry = { type: "custom", customType, data, ...base() }
	return entry
}

function userEntry(text = "fix it"): SessionEntry {
	const message: UserMessage = { role: "user", content: text, timestamp: 0 }
	return messageEntry(message)
}

function assistantEntry(
	text: string,
	opts?: {
		model?: string
		provider?: string
		responseModel?: string
		textless?: boolean
		stopReason?: AssistantMessage["stopReason"]
	},
): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: opts?.textless
			? [{ type: "toolCall", id: nextId(), name: "bash", arguments: {} }]
			: [{ type: "text", text }],
		api: "openai-completions",
		provider: opts?.provider ?? "kimchi-dev",
		model: opts?.model ?? "kimi-k3",
		...(opts?.responseModel !== undefined ? { responseModel: opts.responseModel } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		// pi-mono's vocabulary: "stop" is a clean end_turn; a cancelled or
		// errored turn persists its reply with "aborted"/"error" — the durable
		// settle fact the rating derivation reads.
		stopReason: opts?.stopReason ?? "stop",
		timestamp: 0,
	}
	return messageEntry(message)
}

function toolResultEntry(): SessionEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 0,
	}
	return messageEntry(message)
}

function feedbackSummaryEntry(): SessionEntry {
	return customEntry("feedback-summary", { sentiment: "positive", reason: "ok" })
}

function log(...entries: SessionEntry[]): SessionEntry[] {
	return entries
}

describe("deriveRatingState", () => {
	it("arms for a clean end_turn tail with a concrete model", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done")))
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("does not arm when the reply was cancelled mid-response", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("partial answer", { stopReason: "aborted" })))
		expect(state).toEqual({ armable: false })
	})

	it("does not arm when the reply errored", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("boom", { stopReason: "error" })))
		expect(state).toEqual({ armable: false })
	})

	it("does not arm when the reply was truncated", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("so far", { stopReason: "length" })))
		expect(state).toEqual({ armable: false })
	})

	it("does not arm when the reply carries no stop reason (conservative)", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done", { stopReason: "pending" })))
		expect(state).toEqual({ armable: false })
	})

	it("a later clean reply is rateable even after an earlier cancelled one", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("cancelled reply", { stopReason: "aborted" }),
				userEntry("again"),
				assistantEntry("good"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("does not arm when the tail reply is already rated", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done"), feedbackSummaryEntry()))
		expect(state).toEqual({ armable: false })
	})

	it("a rating of an older reply does not close the tail", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("older"), feedbackSummaryEntry(), userEntry("again"), assistantEntry("newer")),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a log with no assistant reply does not arm", () => {
		const state = deriveRatingState(log(userEntry()))
		expect(state).toEqual({ armable: false })
	})

	it("an empty log does not arm", () => {
		expect(deriveRatingState([])).toEqual({ armable: false })
	})

	it("textless trailing assistant messages do not move the target", () => {
		// A cancel during a tool loop: the visible reply before the loop is a
		// clean artifact and stays rateable; the textless aborted tail is
		// skipped.
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("the real tail"), assistantEntry("", { textless: true, stopReason: "aborted" })),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a tail that only produced a toolCall reply does not arm", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("", { textless: true, stopReason: "aborted" })))
		expect(state).toEqual({ armable: false })
	})

	it("tool results after the tail do not move the attribution target", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("the reply"), toolResultEntry(), feedbackSummaryEntry()),
		)
		expect(state).toEqual({ armable: false })
	})

	it("reports the routed pick for an Auto turn", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("done", { provider: "kimchi-dev", model: "auto", responseModel: "glm-5.3" })),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: true, routedModelId: "glm-5.3" } })
	})

	it("reports no routed pick for an Auto turn whose responseModel is absent", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("done", { provider: "kimchi-dev", model: "auto-beta" })),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: true, routedModelId: undefined } })
	})
})
