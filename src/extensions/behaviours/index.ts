/**
 * Bundled-behaviours extension — phase 1.
 *
 * Concatenates baseline behaviour bodies into a `## Rules` block appended to
 * the system prompt at the start of each agent turn. Triggered behaviours are
 * registered but stay dormant until phase 2 wires session-probe triggers.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { behaviours } from "./registry.js"

const RULES_HEADER = "## Rules"

function buildRulesBlock(): string {
	const baselineBodies = behaviours.filter((b) => b.kind === "baseline").map((b) => b.body.trim())
	if (baselineBodies.length === 0) return ""
	return `\n\n${RULES_HEADER}\n\n${baselineBodies.join("\n\n")}\n`
}

export default function behavioursExtension(pi: ExtensionAPI): void {
	const rulesBlock = buildRulesBlock()
	if (!rulesBlock) return

	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: event.systemPrompt + rulesBlock }
	})
}
