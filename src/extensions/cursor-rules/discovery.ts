/**
 * Discover Cursor-style rule files in and above the current working directory.
 *
 * We collect:
 *   - every `.mdc` file under `.cursor/rules/` at every ancestor level
 *     (closest ancestor wins in rendering order because ancestor-first ordering
 *     is preserved)
 *   - every `.mdc` file under `.agents/rules/` at every ancestor level
 *   - legacy `.cursorrules` files at every ancestor level
 *
 * Globs inside a rule are resolved relative to the directory containing the
 * `.cursor/` or `.agents/` folder (or the directory containing `.cursorrules`).
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parseCursorRule, parseLegacyCursorRules } from "./parser.js"
import type { ParsedCursorRule } from "./types.js"

const CURSOR_RULES_DIR = ".cursor/rules"
const AGENTS_RULES_DIR = ".agents/rules"
const RULES_EXTENSION = ".mdc"
const LEGACY_RULES_FILE = ".cursorrules"

export interface DiscoveredRules {
	/** Rules ordered ancestor-first (root -> cwd). */
	rules: ParsedCursorRule[]
}

export function discoverCursorRules(cwd: string): DiscoveredRules {
	const rules: ParsedCursorRule[] = []
	let dir = resolve(cwd)
	const root = resolve("/")
	const seenPaths = new Set<string>()

	while (true) {
		// Prepend so ancestors collected later end up first (root -> cwd).
		const found: ParsedCursorRule[] = []
		collectRulesFromDir(dir, found, seenPaths)
		rules.unshift(...found)

		if (dir === root) break
		const parent = resolve(dir, "..")
		if (parent === dir) break
		dir = parent
	}

	return { rules }
}

function collectRulesFromDir(dir: string, rules: ParsedCursorRule[], seenPaths: Set<string>): void {
	for (const rulesDir of [join(dir, CURSOR_RULES_DIR), join(dir, AGENTS_RULES_DIR)]) {
		if (existsSync(rulesDir)) {
			for (const filePath of findMdcFiles(rulesDir)) {
				const absPath = resolve(filePath)
				if (seenPaths.has(absPath)) continue
				seenPaths.add(absPath)
				const content = tryReadFile(absPath)
				if (content === null) continue
				rules.push(parseCursorRule(absPath, content))
			}
		}
	}

	const legacyPath = join(dir, LEGACY_RULES_FILE)
	if (existsSync(legacyPath)) {
		const absPath = resolve(legacyPath)
		if (!seenPaths.has(absPath)) {
			seenPaths.add(absPath)
			const content = tryReadFile(absPath)
			if (content !== null) {
				rules.push(parseLegacyCursorRules(absPath, content))
			}
		}
	}
}

function findMdcFiles(dir: string): string[] {
	const results: string[] = []
	walkMdcFiles(dir, "", results)
	return results
}

function walkMdcFiles(dir: string, relativeDir: string, results: string[]): void {
	let entries: Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return
	}

	for (const entry of entries) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			walkMdcFiles(join(dir, entry.name), relativePath, results)
		} else if (entry.isFile() && entry.name.endsWith(RULES_EXTENSION)) {
			results.push(join(dir, entry.name))
		}
	}
}

function tryReadFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8")
	} catch {
		return null
	}
}

export function getRuleBaseDir(rulePath: string): string {
	// `.cursor/rules/<name>.mdc` or `.agents/rules/<name>.mdc` -> directory
	// containing `.cursor/` or `.agents/`.
	if (rulePath.endsWith(RULES_EXTENSION)) {
		return dirname(dirname(dirname(rulePath)))
	}
	// Legacy `.cursorrules` at project root.
	return dirname(rulePath)
}
