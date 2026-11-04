// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { normalizeFermentTitle } from "../../ferment/title.js"
import { derivePlanTitle } from "../../shared/planning/plan-markdown.js"

export function deriveFermentV2Name(objective: string, preferredName?: string): string {
	const planTitle = derivePlanTitle(objective)
	const title =
		normalizeFermentTitle(preferredName) ??
		normalizeFermentTitle(planTitle === "untitled-plan" ? objective : planTitle) ??
		"Untitled run"
	const words = title.split(" ").slice(0, 6)
	while (words.length > 1 && visibleWidth(words.join(" ")) > 36) words.pop()
	return stripTerminalSequences(truncateToWidth(words.join(" "), 36, "…"))
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
