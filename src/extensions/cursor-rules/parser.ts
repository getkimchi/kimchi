/**
 * Parse Cursor rule files.
 *
 * `.cursor/rules/*.mdc` files contain YAML frontmatter followed by markdown.
 * Legacy `.cursorrules` files are plain text and always apply.
 */

import { parse as parseYaml } from "yaml"
import type { ParsedCursorRule } from "./types.js"

const FRONTMATTER_DELIMITER = "---"

export function parseCursorRule(path: string, content: string): ParsedCursorRule {
	const trimmed = content.trimStart()
	let description: string | undefined
	let globs: readonly string[] = []
	let alwaysApply = false
	let body = content

	if (trimmed.startsWith(FRONTMATTER_DELIMITER)) {
		const endIndex = trimmed.indexOf(FRONTMATTER_DELIMITER, FRONTMATTER_DELIMITER.length)
		if (endIndex !== -1) {
			const frontmatter = trimmed.slice(FRONTMATTER_DELIMITER.length, endIndex).trim()
			body = trimmed.slice(endIndex + FRONTMATTER_DELIMITER.length).trimStart()
			if (frontmatter) {
				try {
					const parsed = parseYaml(frontmatter) as Record<string, unknown>
					description = parseDescription(parsed.description)
					alwaysApply = parseAlwaysApply(parsed.alwaysApply)
					globs = parseGlobs(parsed.globs)
				} catch {
					// Malformed frontmatter: fall back to treating the whole file as body.
					body = content
				}
			}
		}
	}

	return { path, description, globs, alwaysApply, body }
}

export function parseLegacyCursorRules(path: string, content: string): ParsedCursorRule {
	return {
		path,
		description: "Legacy .cursorrules file",
		globs: [],
		alwaysApply: true,
		body: content,
	}
}

function parseDescription(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value.trim()
	return undefined
}

function parseAlwaysApply(value: unknown): boolean {
	return value === true
}

function parseGlobs(value: unknown): readonly string[] {
	if (typeof value === "string") {
		return value
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0)
	}
	if (Array.isArray(value)) {
		return value.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
	}
	return []
}
