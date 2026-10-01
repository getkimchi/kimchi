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
