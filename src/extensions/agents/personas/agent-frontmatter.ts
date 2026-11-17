/**
 * agent-frontmatter.ts — Frontmatter parsing for agent .md files.
 *
 * Strict YAML first. Agent files written for other tools often carry an
 * unquoted single-line description containing ": ", which strict YAML
 * rejects; those free-text values are quoted and the parse is retried once.
 * Structured fields (tools, models, …) get no such leniency.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import { parse as parseYaml } from "yaml"

const FREE_TEXT_FIELD = /^(description|display_name):[ \t]+(\S.*)$/

/**
 * Throws a YAML error when the frontmatter cannot be parsed. After a repair
 * that was not enough, it is the error that remains — the one the author has
 * to fix — not the one on the free-text line that is tolerated.
 */
export function parseAgentFrontmatter(content: string): ReturnType<typeof parseFrontmatter> {
	try {
		return parseFrontmatter(content)
	} catch (strictError) {
		const repaired = quoteFreeTextFields(content)
		if (repaired === undefined) throw strictError
		return parseFrontmatter(repaired)
	}
}

/**
 * Quote the free-text fields that are not valid YAML on their own line.
 * Returns undefined when there is nothing to quote.
 */
function quoteFreeTextFields(content: string): string | undefined {
	const lines = content.split(/\r\n|\r|\n/)
	// Line 0 is the opening `---`: parseFrontmatter only throws when a block exists.
	const end = lines.findIndex((line, index) => index > 0 && line.startsWith("---"))
	let quoted = false
	for (let i = 1; i < end; i++) {
		const match = FREE_TEXT_FIELD.exec(lines[i])
		if (!match || parsesAlone(lines[i])) continue
		lines[i] = `${match[1]}: ${JSON.stringify(match[2].trimEnd())}`
		quoted = true
	}
	return quoted ? lines.join("\n") : undefined
}

function parsesAlone(line: string): boolean {
	try {
		// "error" keeps YAML warnings off the console; errors still throw.
		parseYaml(line, { logLevel: "error" })
		return true
	} catch {
		return false
	}
}
