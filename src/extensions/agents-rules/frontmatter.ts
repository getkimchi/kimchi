/**
 * Frontmatter parsing for `.agents/rules/` rule files.
 *
 * Reuses the upstream `parseFrontmatter` primitive (yaml-backed) and layers
 * the validation specific to rule frontmatter:
 *
 * - `description`  — optional string
 * - `globs`        — string (comma-separated) or list of strings
 * - `alwaysApply`  — boolean; the strings "true"/"false" are coerced
 *
 * Malformed YAML or wrong-typed fields throw `RuleParseError` with a
 * readable message; callers (discovery) catch it and record a diagnostic
 * instead of failing the whole scan.
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent"

export interface RuleFrontmatter {
	description?: string
	globs: string[]
	alwaysApply: boolean
}

export interface ParsedRuleFile {
	frontmatter: RuleFrontmatter
	/** Markdown body with frontmatter stripped and trimmed. */
	body: string
	/** True when the file had no frontmatter block at all. */
	hasFrontmatter: boolean
}

/** Error thrown when a rule file's frontmatter cannot be parsed or validated. */
export class RuleParseError extends Error {
	constructor(
		message: string,
		/** Absolute path of the offending rule file, if known. */
		readonly rulePath?: string,
	) {
		super(rulePath ? `${rulePath}: ${message}` : message)
		this.name = "RuleParseError"
	}
}

/** Split a comma-separated glob string into patterns. */
function splitGlobString(value: string): string[] {
	return value
		.split(",")
		.map((pattern) => pattern.trim())
		.filter((pattern) => pattern.length > 0)
}

function coerceAlwaysApply(value: unknown, rulePath?: string): boolean {
	if (value === undefined || value === null) return false
	if (typeof value === "boolean") return value
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase()
		if (normalized === "true") return true
		if (normalized === "false" || normalized === "") return false
	}
	throw new RuleParseError(
		`frontmatter field "alwaysApply" must be a boolean or "true"/"false" string, got: ${JSON.stringify(value)}`,
		rulePath,
	)
}

function coerceGlobs(value: unknown, rulePath?: string): string[] {
	if (value === undefined || value === null) return []
	if (typeof value === "string") return splitGlobString(value)
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			if (typeof entry === "string") return splitGlobString(entry)
			throw new RuleParseError(
				`frontmatter field "globs" must contain only strings, got: ${JSON.stringify(entry)}`,
				rulePath,
			)
		})
	}
	throw new RuleParseError(
		`frontmatter field "globs" must be a string or a list of strings, got: ${typeof value}`,
		rulePath,
	)
}

function coerceDescription(value: unknown, rulePath?: string): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value === "string") {
		const trimmed = value.trim()
		return trimmed.length > 0 ? trimmed : undefined
	}
	throw new RuleParseError(`frontmatter field "description" must be a string, got: ${typeof value}`, rulePath)
}

/** Parse a rule file's raw content into validated frontmatter and body.
 *  Throws `RuleParseError` on malformed YAML or invalid field types. */
export function parseRuleFile(raw: string, rulePath?: string): ParsedRuleFile {
	const hasFrontmatter = raw.trimStart().startsWith("---")

	let parsed: { frontmatter: Record<string, unknown>; body: string }
	try {
		parsed = parseFrontmatter(raw)
	} catch (error) {
		throw new RuleParseError(
			`invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
			rulePath,
		)
	}

	const fm = parsed.frontmatter as Record<string, unknown>
	const description = coerceDescription(fm.description, rulePath)

	return {
		frontmatter: {
			description,
			globs: coerceGlobs(fm.globs, rulePath),
			alwaysApply: coerceAlwaysApply(fm.alwaysApply, rulePath),
		},
		body: parsed.body.trim(),
		hasFrontmatter,
	}
}
