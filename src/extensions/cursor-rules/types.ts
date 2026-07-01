/**
 * Shared types for the Cursor rules extension.
 *
 * Cursor rules are markdown instruction files. The modern `.mdc` format uses
 * YAML frontmatter to control when a rule is injected:
 *   - `alwaysApply: true`  -> always included
 *   - `globs`              -> included when a touched file matches
 *   - `description`        -> listed as available; agent decides relevance
 *   - none of the above    -> listed as available; only via @mention
 *
 * Legacy `.cursorrules` files are treated as a single always-apply rule.
 */

export interface ParsedCursorRule {
	/** Absolute path to the rule file. */
	path: string
	/** Optional one-line summary used by the agent to decide relevance. */
	description: string | undefined
	/** Glob patterns that trigger the rule when a touched file matches. */
	globs: readonly string[]
	/** Whether the rule should always be injected. */
	alwaysApply: boolean
	/** The markdown body of the rule. */
	body: string
}
