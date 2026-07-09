/**
 * Decide which Cursor rules are active for the current turn.
 *
 * A rule can be:
 *   - alwaysApply: true     -> always active
 *   - globs present         -> active if any touched file matches a glob
 *   - description present   -> listed as available; agent decides relevance
 *   - none of the above     -> listed as available; only via @mention
 */

import { relative } from "node:path"
import micromatch from "micromatch"
import { getRuleBaseDir } from "./discovery.js"
import type { ParsedCursorRule } from "./types.js"

export interface ActiveRules {
	/** Rules that always apply. */
	alwaysApply: ParsedCursorRule[]
	/** Rules whose globs matched at least one touched file. */
	matched: ParsedCursorRule[]
	/** Rules available for agent-requested or manual use. */
	available: ParsedCursorRule[]
}

export function getActiveRules(rules: readonly ParsedCursorRule[], touchedFiles: ReadonlySet<string>): ActiveRules {
	const result: ActiveRules = { alwaysApply: [], matched: [], available: [] }

	for (const rule of rules) {
		if (rule.alwaysApply) {
			result.alwaysApply.push(rule)
			continue
		}

		if (rule.globs.length > 0) {
			if (matchesAnyGlob(rule, touchedFiles)) {
				result.matched.push(rule)
			}
			continue
		}

		result.available.push(rule)
	}

	return result
}

function matchesAnyGlob(rule: ParsedCursorRule, touchedFiles: ReadonlySet<string>): boolean {
	const baseDir = getRuleBaseDir(rule.path)
	for (const filePath of touchedFiles) {
		const rel = relative(baseDir, filePath)
		if (rel.startsWith("..")) continue
		if (micromatch.isMatch(rel, rule.globs as string[])) return true
	}
	return false
}
