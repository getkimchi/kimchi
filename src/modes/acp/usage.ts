import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { TurnContext, TurnUsage } from "./types.js"

export function emptyTurnUsage(): TurnUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		total: 0,
		sawReasoning: false,
		messages: 0,
	}
}

export function updateTurnUsage(turn: TurnContext, usage: AssistantMessage["usage"]): void {
	// `|| 0` guards against providers emitting undefined/NaN for a
	// field the type declares required — one bad message must not
	// poison the whole turn's totals.
	turn.usage.input += usage.input || 0
	turn.usage.output += usage.output || 0
	turn.usage.cacheRead += usage.cacheRead || 0
	turn.usage.cacheWrite += usage.cacheWrite || 0
	turn.usage.total += usage.totalTokens || 0
	// reasoning is a SUBSET of output (pi-ai 0.84 Usage docs) — summed
	// separately for thoughtTokens only, never re-added to totals.
	if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
		turn.usage.reasoning += usage.reasoning
		turn.usage.sawReasoning = true
	}
	turn.usage.messages++
}
