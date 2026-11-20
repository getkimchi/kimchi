/**
 * Session state for agent rules.
 *
 * Holds the discovered rules and tracks which glob-matched rules have already
 * been activated in the current session (each rule activates at most once —
 * re-steering after compaction is the wiring layer's job, not a re-activation).
 *
 * Always-apply rules are exposed for the static system-prompt block; available
 * rules are exposed as an index for the prompt; glob rules activate through
 * `handleToolCall` when a read/edit/write touches a matching file.
 */

import { relative } from "node:path"
import { extractFilePath, matchesRule } from "./matcher.js"
import type { AgentRule } from "./types.js"

/** Index entry for an available (on-demand) rule. */
export interface AvailableRuleEntry {
	name: string
	description?: string
	/** Path relative to the session cwd, so the agent can `read` the rule. */
	relativePath: string
}

export class AgentRulesEngine {
	private readonly rules: readonly AgentRule[]
	private readonly cwd: string
	private readonly activated = new Set<string>()

	constructor(rules: readonly AgentRule[], cwd: string) {
		this.rules = rules
		this.cwd = cwd
	}

	/** Clear activation state — a new session (start/switch/fork) starts fresh. */
	reset(): void {
		this.activated.clear()
	}

	/** Rules with `alwaysApply: true`, in discovery (ancestor-first) order. */
	getAlwaysApplyRules(): AgentRule[] {
		return this.rules.filter((rule) => rule.mode === "always")
	}

	/** Rules activated by glob match, in discovery order. */
	getGlobRules(): AgentRule[] {
		return this.rules.filter((rule) => rule.mode === "glob")
	}

	/** Available rules — listed in the system prompt index so the agent can
	 *  read the full rule file when it determines it is relevant. */
	getAvailableIndex(): AvailableRuleEntry[] {
		return this.rules
			.filter((rule) => rule.mode === "available")
			.map((rule) => {
				const entry: AvailableRuleEntry = { name: rule.name, relativePath: relative(this.cwd, rule.path) }
				if (rule.description !== undefined) entry.description = rule.description
				return entry
			})
	}

	/** Rules already activated this session (e.g. for re-steer after compaction). */
	getActivatedRules(): AgentRule[] {
		return this.rules.filter((rule) => this.activated.has(rule.path))
	}

	/** Handle a tool call: activate (once) every not-yet-activated glob rule
	 *  whose globs match the file the tool touches. Returns only the newly
	 *  activated rules, in discovery order. */
	handleToolCall(toolName: string, input: unknown): AgentRule[] {
		const filePath = extractFilePath(toolName, input)
		if (filePath === undefined) return []

		const newlyActivated: AgentRule[] = []
		for (const rule of this.getGlobRules()) {
			if (this.activated.has(rule.path)) continue
			if (matchesRule(rule, filePath, this.cwd)) {
				this.activated.add(rule.path)
				newlyActivated.push(rule)
			}
		}
		return newlyActivated
	}
}
