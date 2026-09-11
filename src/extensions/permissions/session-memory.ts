import {
	extractBashProgram,
	FILE_TOOLS,
	parseCommandSegments,
	splitCompoundCommand,
	splitLeadingEnv,
	stripTrailingOutputFilters,
} from "./taxonomy.js"
import type { Rule } from "./types.js"

export interface Scope {
	toolName: string
	content?: string
	wildcardContent?: string
	label: string
}

export class SessionMemory {
	private rules: Rule[] = []

	add(rule: Rule): void {
		this.rules.push(rule)
	}

	addMany(rules: Rule[]): void {
		// Dedupe by (toolName, content, behavior): repeated segments in one
		// compound (`npm install && npm install`) must not pile up duplicates.
		const keyOf = (rule: Rule) => `${rule.toolName}${rule.content ?? ""}${rule.behavior}`
		const seen = new Set(this.rules.map(keyOf))
		for (const rule of rules) {
			const key = keyOf(rule)
			if (seen.has(key)) continue
			seen.add(key)
			this.rules.push(rule)
		}
	}

	all(): Rule[] {
		return [...this.rules]
	}

	clear(): void {
		this.rules = []
	}
}

// Scope suggestion for "don't ask again this session":
//   bash  → `program[ subcommand]:*` (subcommand dropped when it's a flag)
//   file  → directory glob (`src/cli.ts` → `src/**`)
//   other → tool name only
export function suggestScope(toolName: string, input: Record<string, unknown>): Scope {
	const lower = toolName.toLowerCase()

	if (lower === "bash") {
		const command = typeof input.command === "string" ? input.command : ""
		return bashScope(command)
	}

	if (FILE_TOOLS.has(lower)) {
		const path = typeof input.path === "string" ? input.path : ""
		const glob = dirGlob(path)
		if (glob) {
			return { toolName: lower, content: glob, label: `${lower}(${glob})` }
		}
		return { toolName: lower, content: undefined, label: lower }
	}

	return { toolName: lower, content: undefined, label: lower }
}

function bashScope(command: string): Scope {
	const prefix = bashPrefixScope(command)
	if (prefix) {
		return {
			toolName: "bash",
			content: `${prefix}:*`,
			wildcardContent: `${bashProgramOnly(command)} *`,
			label: `bash(${prefix}:*)`,
		}
	}
	return { toolName: "bash", content: undefined, label: "bash" }
}

export interface BashCommandScopes {
	/** One narrow scope per scopeable command segment (order preserved). */
	scopes: Scope[]
	/** False when ANY segment cannot derive a scope that would ever match again. */
	scopeable: boolean
}

/**
 * Scope for a single bash command segment, or null when no derived scope can
 * ever match it again. Null cases:
 *  - no program (empty, backtick/command substitution)
 *  - the segment parses as multiple shell segments AND is not safely
 *    normalizable: a pipeline whose trailing stages are whitelisted output
 *    filters (`cat log | tail -20`) normalizes to its head, whose scope the
 *    matcher can honor on rerun; pipelines touching anything else (`| sh`,
 *    `| tee`, `| awk`) stay unscopeable because matchBashRule's single-segment
 *    canonical gate rejects broad patterns against them.
 */
export function bashSegmentScope(command: string): Scope | null {
	const normalized = stripTrailingOutputFilters(command)
	const source = normalized ?? command
	if (parseCommandSegments(source).length !== 1) return null
	const scope = bashScope(source)
	return scope.content ? scope : null
}

/**
 * Per-segment scopes for a possibly-compound bash command. The compound gate
 * (checkCompoundCommand) evaluates rules per segment, so a remembered compound
 * only sticks when every segment that NEEDS a rule carries a scope that can
 * match (read-only non-cwd segments are implicitly allowed at the gate and
 * need no rule; cwd-changers like `cd /tmp` always need one). `scopeable:
 * false` tells callers to not offer a "don't ask again" choice they could
 * not honor.
 */
export function suggestBashCommandScopes(command: string): BashCommandScopes {
	const segments = splitCompoundCommand(command) ?? [command]
	const scopes: Scope[] = []
	let scopeable = true
	for (const segment of segments) {
		const scope = bashSegmentScope(segment)
		if (scope) scopes.push(scope)
		else scopeable = false
	}
	return { scopes, scopeable }
}

// Verbatim leading env prefix (e.g. "GOWORK=off ") or "" — preserved in remembered
// scopes because the shell applies it at execution, so it is part of what was approved.
function envPrefix(command: string): string {
	const { env } = splitLeadingEnv(command)
	return env.length ? `${env.join(" ")} ` : ""
}

function bashProgramOnly(command: string): string {
	const trimmed = command.trim()
	if (!trimmed) return ""
	const { program } = extractBashProgram(trimmed)
	if (!program) return ""
	return `${envPrefix(trimmed)}${program}`
}

function bashPrefixScope(command: string): string | null {
	const trimmed = command.trim()
	if (!trimmed) return null

	const { program, subcommand } = extractBashProgram(trimmed)
	if (!program) return null
	const base = !subcommand || subcommand.startsWith("-") ? program : `${program} ${subcommand}`
	return `${envPrefix(trimmed)}${base}`
}

function dirGlob(path: string): string | null {
	if (!path) return null
	const idx = path.lastIndexOf("/")
	if (idx <= 0) return path
	return `${path.slice(0, idx)}/**`
}
