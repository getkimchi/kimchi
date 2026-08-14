import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import type { Behaviour } from "./types.js"

const RULES_HEADER = "## Rules"

/** Build the baseline rules block from all baseline behaviours in the manifest.
 *  Returns an empty string when there are no baseline behaviours, so the block
 *  registration can skip cleanly. */
export function buildRulesBlock(all: readonly Behaviour[]): string {
	const baseline = all.filter((b) => b.kind === "baseline").map((b) => b.body.trim())
	if (baseline.length === 0) return ""
	return `${RULES_HEADER}\n\n${baseline.join("\n\n")}`
}

/** Register the static baseline-rules system-prompt block. Kept in its own
 *  file so the dynamic `triggered:*` registrar in `wiring.ts` can read the
 *  trigger engine while the rules block stays strictly static — see
 *  system-prompt-stability.contract.test.ts. */
export function registerRulesBlock(pi: ExtensionAPI, behaviours: readonly Behaviour[]): void {
	const rulesBlock = buildRulesBlock(behaviours)
	if (!rulesBlock) return
	createSystemPromptBlocks(pi, "behaviours").register({
		id: "rules",
		render: () => rulesBlock.trim(),
	})
}
