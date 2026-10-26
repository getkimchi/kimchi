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
	opts?: { model?: string; provider?: string; responseModel?: string; textless?: boolean },
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
		stopReason: "stop",
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

function turnEndEntry(stopReason: unknown): SessionEntry {
	return customEntry("turn_end", { stopReason })
}

function feedbackSummaryEntry(): SessionEntry {
	return customEntry("feedback-summary", { sentiment: "positive", reason: "ok" })
}

function log(...entries: SessionEntry[]): SessionEntry[] {
	return entries
}

describe("deriveRatingState", () => {
	it("arms for an end_turn-stamped tail with a concrete model", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done"), turnEndEntry("end_turn")))
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("does not arm when the tail's turn aborted", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("partial"), turnEndEntry("aborted")))
		expect(state).toEqual({ armable: false })
	})

	it("does not arm when the tail's turn errored", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("boom"), turnEndEntry("error")))
		expect(state).toEqual({ armable: false })
	})

	it("legacy: a log with no turn_end stamps counts its tail as settled", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done")))
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a stamp-bearing log with an unstamped tail does not arm", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("first"), turnEndEntry("end_turn"), userEntry("again"), assistantEntry("second")),
		)
		expect(state).toEqual({ armable: false })
	})

	it("does not arm when the tail reply is already rated", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("done"), turnEndEntry("end_turn"), feedbackSummaryEntry()),
		)
		expect(state).toEqual({ armable: false })
	})

	it("a rating of an older reply does not close the tail", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("older"),
				turnEndEntry("end_turn"),
				feedbackSummaryEntry(),
				userEntry("again"),
				assistantEntry("newer"),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a log with no assistant reply does not arm", () => {
		const state = deriveRatingState(log(userEntry(), turnEndEntry("end_turn")))
		expect(state).toEqual({ armable: false })
	})

	it("an empty log does not arm", () => {
		expect(deriveRatingState([])).toEqual({ armable: false })
	})

	it("textless trailing assistant messages do not move the target", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("the real tail"),
				assistantEntry("", { textless: true }),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a tail that only produced a toolCall reply does not arm", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("", { textless: true }), turnEndEntry("end_turn")))
		expect(state).toEqual({ armable: false })
	})

	it("toolResults between the reply and its terminator keep the attribution", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("thinking"),
				assistantEntry("", { textless: true }),
				toolResultEntry(),
				assistantEntry("final"),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("a terminator after the next user prompt does not stamp the previous reply", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("orphan"), userEntry("again"), turnEndEntry("aborted")),
		)
		expect(state).toEqual({ armable: false })
	})

	it("an earlier aborted terminator does not poison a later clean tail", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("aborted reply"),
				turnEndEntry("aborted"),
				userEntry("again"),
				assistantEntry("good"),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("reports the routed pick for an Auto turn", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("done", { provider: "kimchi-dev", model: "auto", responseModel: "glm-5.3" }),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: true, routedModelId: "glm-5.3" } })
	})

	it("reports no routed pick for an Auto turn whose responseModel is absent", () => {
		const state = deriveRatingState(
			log(
				userEntry(),
				assistantEntry("done", { provider: "kimchi-dev", model: "auto-beta" }),
				turnEndEntry("end_turn"),
			),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: true, routedModelId: undefined } })
	})

	it("skips malformed turn_end entries and still honors a later valid stamp", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("done"), turnEndEntry({ nope: true }), turnEndEntry("end_turn")),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("treats a turn_end whose stopReason is not a string as malformed (skipped, legacy tail rule)", () => {
		const state = deriveRatingState(
			log(userEntry(), assistantEntry("done"), customEntry("turn_end", { stopReason: 42 })),
		)
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})

	it("treats a log whose turn_end data is not a record as stamp-less (legacy)", () => {
		const state = deriveRatingState(log(userEntry(), assistantEntry("done"), customEntry("turn_end", "garbage")))
		expect(state).toEqual({ armable: true, window: { autoModelUsed: false, routedModelId: undefined } })
	})
})
