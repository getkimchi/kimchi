// Transcript-derived rating state: walks the session's persisted entries and
// decides whether the rating window may arm for the session's last settled,
// unrated reply — the same fact the live settle path arms from, reconstructed
// from the log so a session loaded in a fresh process (TUI resume, ACP
// `session/load`) rates exactly like one that just settled.
//
// The walk mirrors Studio's sessionJsonlParser so both derivations agree on
// every log: the target of a rating stamp is the last assistant reply with
// visible text (textless entries never render), and a user prompt moves the
// target off the reply.
//
// The settled fact is the reply's own persisted `stopReason` — written into
// every assistant message entry since always ("stop" is a clean end_turn in
// pi-mono's vocabulary, the ACP wire calls it "end_turn"; a cancelled or
// errored turn persists its partial reply with "aborted"/"error"), so no
// separate termination record is needed. A cancel before the reply's first
// token leaves no entry and is invisible on disk: the previous settled reply
// remains the tail and arms — accepted, documented divergence.

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "../auto-model/constants.js"
import type { RatingWindow } from "./rating-window.js"
import { FEEDBACK_SUMMARY_CUSTOM_TYPE } from "./record-rating.js"

export type DerivedRatingState = { armable: false } | { armable: true; window: RatingWindow }

/** The assistant message a rendered reply belongs to, or undefined for
 * anything without visible text (toolCall-only tails, empty text). */
function visibleAssistant(entry: SessionEntry): AssistantMessage | undefined {
	if (entry.type !== "message" || entry.message.role !== "assistant") return undefined
	let text = ""
	for (const block of entry.message.content) {
		if (block.type === "text") text += block.text
	}
	return text.trim().length > 0 ? entry.message : undefined
}

/** The settled turn's window payload, from the rated reply's own persisted
 * entry: the requested model names the routed virtual (`auto*` on the
 * kimchi-dev provider) and `responseModel` carries the backend-stamped pick
 * the live window would have captured at settle time. */
function ratingWindowFor(tail: AssistantMessage): RatingWindow {
	const autoModelUsed = isAutoRoutedModel({ provider: tail.provider, id: tail.model })
	return {
		autoModelUsed,
		routedModelId: autoModelUsed ? (tail.responseModel ?? undefined) : undefined,
	}
}

export function deriveRatingState(entries: readonly SessionEntry[]): DerivedRatingState {
	// The tail: the session's last assistant reply with visible text.
	let tailIndex = -1
	let tail: AssistantMessage | undefined
	for (let i = entries.length - 1; i >= 0; i--) {
		const visible = visibleAssistant(entries[i])
		if (visible !== undefined) {
			tailIndex = i
			tail = visible
			break
		}
	}
	if (tail === undefined || tailIndex < 0) return { armable: false }

	// Only a clean end_turn reply is rateable: the reply's own persisted
	// stop reason records what happened to it ("aborted" = cancelled,
	// "error" = failed, "length" = truncated). A turn-level cancel is
	// therefore not rateable on restore — matching the live gate.
	if (tail.stopReason !== "stop") return { armable: false }

	// Whether an entry moves the positional target off the tail: a user
	// prompt clears it and a newer visible reply replaces it. Tool results
	// and ratings keep it.
	const movesTarget = (entry: SessionEntry): boolean =>
		visibleAssistant(entry) !== undefined || (entry.type === "message" && entry.message.role === "user")

	// Already rated? A feedback-summary reaching the tail (nothing in between
	// moved the target) records it; ratings of older replies sit behind a
	// user prompt and never close the tail.
	for (let i = tailIndex + 1; i < entries.length; i++) {
		const entry = entries[i]
		if (movesTarget(entry)) break
		if (entry.type === "custom" && entry.customType === FEEDBACK_SUMMARY_CUSTOM_TYPE) {
			return { armable: false }
		}
	}

	return { armable: true, window: ratingWindowFor(tail) }
}
