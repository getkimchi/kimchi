/**
 * Central allow-list of models whose tool-calling shows the "narrate a next
 * step, then stop without emitting the tool call" behavior: the model writes
 * prose describing what it will do next and ends its turn without producing the
 * tool call, leaving the agent loop stuck.
 *
 * The continuation nudge exists to recover from exactly that state, but it must
 * only run for models that show it. A nudge sent to a model without the quirk
 * can be read by that model as fresh user input and push it past a legitimate
 * stop (for example a genuine question it was waiting on an answer for), so the
 * nudge is scoped tightly to the ids listed here rather than applied by default.
 *
 * New ids are added to this one array. Matching is a lower-cased substring
 * test, so provider prefixes (for example `kimchi-dev/kimi-k2.6`) and point
 * releases (`kimi-k2.7`) are covered by a single entry.
 */
const CONTINUATION_STALL_QUIRK_MODEL_SUBSTRINGS = ["kimi-k2", "minimax-m3"]

/** Returns true when the model id belongs to a family with the narrate-then-stop tool-calling quirk. */
export function modelHasContinuationStallQuirk(modelId: string | undefined): boolean {
	if (!modelId) return false
	const id = modelId.toLowerCase()
	return CONTINUATION_STALL_QUIRK_MODEL_SUBSTRINGS.some((substring) => id.includes(substring))
}
