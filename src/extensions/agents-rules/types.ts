/**
 * Agent rules discovered from `.agents/rules/` directories.
 *
 * A rule is a markdown file (`.mdc` or `.md`) with optional YAML frontmatter
 * that controls when it activates:
 *
 * - `alwaysApply: true`  → always merged into the system prompt
 * - `globs: [...]`       → injected when the agent reads/writes/edits a
 *                           file matching one of the glob patterns
 * - otherwise            → listed as available; the agent can read the rule
 *                           file when it determines it is relevant
 *
 * Scope is deliberately `.agents/rules/` only (agent-agnostic convention —
 * see agentsmd/agents.md#179 and the Prisma canonical-home precedent).
 */

export type AgentRuleMode = "always" | "glob" | "available"

export interface AgentRule {
	/** Absolute path to the rule file. */
	path: string
	/** Rule name — the filename stem (e.g. `api-conventions` for `api-conventions.mdc`). */
	name: string
	/** One-line summary from frontmatter; used in the available-rules index. */
	description?: string
	/** Glob patterns (frontmatter `globs`, comma-separated strings accepted). */
	globs: string[]
	/** Whether the rule is always merged into the system prompt. */
	alwaysApply: boolean
	/** Rule body (markdown instructions) with frontmatter stripped. */
	body: string
	/** Directory containing the `.agents/` folder — the root glob patterns
	 *  are resolved against (a rule in an ancestor's `.agents/rules/` matches
	 *  paths relative to that ancestor). */
	baseDir: string
	/** Derived activation mode. `alwaysApply` wins over `globs`. */
	mode: AgentRuleMode
}

/** Derive the activation mode from parsed frontmatter fields. */
export function ruleMode(rule: Pick<AgentRule, "alwaysApply" | "globs">): AgentRuleMode {
	if (rule.alwaysApply) return "always"
	if (rule.globs.length > 0) return "glob"
	return "available"
}
