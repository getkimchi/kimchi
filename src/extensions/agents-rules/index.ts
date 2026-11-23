/**
 * Agent rules extension — loads `.agents/rules/` rule files (`.mdc`/`.md`
 * with YAML frontmatter) and delivers them by activation mode:
 *
 * - **always** (`alwaysApply: true`) — merged into the `## Rules` system
 *   prompt block at every turn (registered once per session via
 *   `createSystemPromptBlocks`, mirroring `behaviours/rules-block.ts`).
 * - **glob** (`globs: [...]`) — steer-delivered when the agent reads/writes/
 *   edits a file matching a glob pattern: matched on `tool_call`, drained as
 *   a steer on the following `tool_result` so the model sees the rule before
 *   its next inference in the same turn. Steer-only delivery (no late system
 *   prompt render) protects the provider cache — same delivery class as
 *   tool-triggered behaviours. After compaction, activated rules outside the
 *   keep-recent window are re-steered so the guidance stays actionable.
 * - **available** (description only / no frontmatter) — listed in an index
 *   inside the `## Rules` block; the agent can `read` the rule file on demand.
 *
 * Discovery runs on every `session_start` (pi re-fires it on reload, new,
 * fork and resume), so rule edits are picked up without restarting Kimchi.
 * Files with malformed frontmatter are skipped with a console warning —
 * they never break the session.
 *
 * Rule files ship with the repo and their bodies reach the system prompt
 * and steers, so discovery is gated on project trust (fail-closed).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isProjectScopeAllowed } from "../../project-scope-trust.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { markHarnessSteer } from "../steer-marker.js"
import { survivingSteerNames } from "../steer-survival.js"
import { discoverAgentRules } from "./discovery.js"
import { AgentRulesEngine } from "./engine.js"
import type { AgentRule } from "./types.js"

/** Custom message type for steered rule bodies. */
export const AGENTS_RULE_BODY_TYPE = "agents-rule"

interface RuleBodyDetails {
	name: string
	/** Why the body was steered — absent on first delivery, "compaction" on re-steer. */
	reason?: "compaction"
}

/** Build the static `## Rules` block: always-apply bodies plus the
 *  available-rules index. Returns undefined when there is nothing to render. */
export function buildRulesBlock(engine: AgentRulesEngine): string | undefined {
	const sections: string[] = []

	const always = engine.getAlwaysApplyRules()
	if (always.length > 0) {
		sections.push(always.map((rule) => rule.body.trim()).join("\n\n"))
	}

	const available = engine.getAvailableIndex()
	if (available.length > 0) {
		const lines = available.map((entry) => {
			const description = entry.description ? ` — ${entry.description}` : ""
			return `- **${entry.name}**${description} (\`${entry.relativePath}\`)`
		})
		sections.push(
			`### Available rules\n\nThe following project rule files are available. Read one with the \`read\` tool when it becomes relevant to your task:\n\n${lines.join("\n")}`,
		)
	}

	if (sections.length === 0) return undefined
	return `## Rules\n\n${sections.join("\n\n")}`
}

function steerRule(pi: ExtensionAPI, rule: AgentRule, reason?: "compaction"): void {
	const details: RuleBodyDetails = reason ? { name: rule.name, reason } : { name: rule.name }
	pi.sendMessage(
		{
			customType: AGENTS_RULE_BODY_TYPE,
			content: markHarnessSteer(rule.body),
			display: false,
			details,
		},
		{ deliverAs: "steer" },
	)
}

export default function agentsRulesExtension(pi: ExtensionAPI): void {
	const blocks = createSystemPromptBlocks(pi, "agents-rules")
	let engine: AgentRulesEngine | undefined
	/** Rules matched on tool_call, drained as steers on the next tool_result. */
	const pendingSteer: AgentRule[] = []

	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd
		// Project-trust gate: rule files ship with the repo, so their bodies
		// must not reach the system prompt or steers before it is trusted.
		if (!isProjectScopeAllowed(cwd)) {
			engine = undefined
			pendingSteer.length = 0
			return
		}
		const { rules, diagnostics } = discoverAgentRules(cwd)
		for (const diagnostic of diagnostics) {
			console.warn(`agents-rules: skipping rule ${diagnostic.path}: ${diagnostic.message}`)
		}
		engine = new AgentRulesEngine(rules, cwd)
		pendingSteer.length = 0

		blocks.register({
			id: "rules",
			render: () => (engine ? buildRulesBlock(engine) : undefined),
		})
	})

	pi.on("tool_call", async (event) => {
		if (engine === undefined) return
		pendingSteer.push(...engine.handleToolCall(event.toolName, event.input))
	})

	// Drain matched rules as steer messages right after the tool result so the
	// model sees them before its next inference within the same turn (the
	// system prompt is rebuilt only per user prompt). The engine's
	// once-per-session activation makes the queue itself idempotent.
	pi.on("tool_result", async () => {
		while (pendingSteer.length > 0) {
			const rule = pendingSteer.shift()
			if (rule) steerRule(pi, rule)
		}
	})

	// Re-steer activated glob rules that the compaction rewrite dropped. Rules
	// whose steer is still inside the keep-recent window are skipped —
	// re-steering them would duplicate the body in every request until the
	// next compaction.
	pi.on("session_compact", async (event, ctx) => {
		if (engine === undefined) return
		const keptNames = survivingSteerNames(event, ctx, AGENTS_RULE_BODY_TYPE)
		for (const rule of engine.getActivatedRules()) {
			if (keptNames?.has(rule.name)) continue
			steerRule(pi, rule, "compaction")
		}
	})
}
