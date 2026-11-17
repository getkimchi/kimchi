/**
 * Discovery of agent rules in `.agents/rules/` directories.
 *
 * Walks from the working directory up to the filesystem root (or an optional
 * limit), collecting `.agents/rules/` directories at every ancestor level.
 * Each rules directory is scanned recursively for `*.mdc` and `*.md` files.
 *
 * Rules are returned ancestor-first (root-level rules first, cwd-level
 * last), mirroring the project context file convention: higher-level rules
 * provide the baseline, closer rules refine them. Files are deduplicated by
 * absolute path and sorted deterministically (by path) within a directory.
 *
 * A file with malformed frontmatter is skipped and recorded as a diagnostic
 * — a broken rule must never fail the whole discovery.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, parse, resolve, sep } from "node:path"
import { parseRuleFile, RuleParseError } from "./frontmatter.js"
import { type AgentRule, ruleMode } from "./types.js"

export const RULES_DIR_SEGMENTS = [".agents", "rules"]
export const RULE_FILE_EXTENSIONS = [".mdc", ".md"]

export interface RuleDiagnostic {
	/** Absolute path of the offending rule file. */
	path: string
	/** Human-readable reason the file was skipped. */
	message: string
}

export interface RuleDiscoveryResult {
	/** Discovered rules, ancestor-first, deterministic within a level. */
	rules: AgentRule[]
	/** Diagnostics for files that were skipped (e.g. malformed frontmatter). */
	diagnostics: RuleDiagnostic[]
}

export interface DiscoverAgentRulesOptions {
	/** Upper bound for the ancestor walk. Defaults to the filesystem root. */
	rootLimit?: string
}

/** True when `dir` contains a `.agents/rules/` directory. */
function isRulesDir(dir: string): boolean {
	try {
		return statSync(join(dir, ...RULES_DIR_SEGMENTS)).isDirectory()
	} catch {
		return false
	}
}

/** Collect `.mdc`/`.md` files in `rulesDir`, recursing into subdirectories.
 *  Hidden entries (dotfiles/dot-directories) are skipped. */
function collectRuleFiles(rulesDir: string): string[] {
	const files: string[] = []
	const walk = (dir: string): void => {
		let entries: Dirent[]
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue
			const entryPath = join(dir, entry.name)
			if (entry.isDirectory()) {
				walk(entryPath)
			} else if (entry.isFile() && RULE_FILE_EXTENSIONS.includes(parse(entry.name).ext.toLowerCase())) {
				files.push(entryPath)
			}
		}
	}
	walk(rulesDir)
	return files
}

/** Load and parse a single rule file. Returns a diagnostic on parse failure. */
function loadRule(filePath: string, baseDir: string): { rule?: AgentRule; diagnostic?: RuleDiagnostic } {
	let raw: string
	try {
		raw = readFileSync(filePath, "utf-8")
	} catch (error) {
		return {
			diagnostic: {
				path: filePath,
				message: `could not read rule file: ${error instanceof Error ? error.message : String(error)}`,
			},
		}
	}

	try {
		const { frontmatter, body } = parseRuleFile(raw, filePath)
		const rule: AgentRule = {
			path: filePath,
			name: parse(basename(filePath)).name,
			description: frontmatter.description,
			globs: frontmatter.globs,
			alwaysApply: frontmatter.alwaysApply,
			body,
			baseDir,
			mode: ruleMode(frontmatter),
		}
		return { rule }
	} catch (error) {
		if (error instanceof RuleParseError) {
			return { diagnostic: { path: filePath, message: error.message } }
		}
		return {
			diagnostic: {
				path: filePath,
				message: `unexpected parse failure: ${error instanceof Error ? error.message : String(error)}`,
			},
		}
	}
}

/** Discover agent rules from `cwd` up to the filesystem root (or `rootLimit`).
 *  Never throws — malformed files are reported via `diagnostics`. */
export function discoverAgentRules(cwd: string, options: DiscoverAgentRulesOptions = {}): RuleDiscoveryResult {
	const resolvedCwd = resolve(cwd)
	const rootLimit = options.rootLimit ? resolve(options.rootLimit) : parse(resolvedCwd).root
	if (!resolvedCwd.startsWith(rootLimit.endsWith(sep) ? rootLimit : rootLimit + sep)) {
		// cwd outside the limit — nothing to discover.
		return { rules: [], diagnostics: [] }
	}

	// Walk cwd → root collecting directories that contain `.agents/rules/`.
	const rulesDirs: Array<{ dir: string; baseDir: string }> = []
	let current = resolvedCwd
	while (true) {
		if (isRulesDir(current)) {
			rulesDirs.push({ dir: join(current, ...RULES_DIR_SEGMENTS), baseDir: current })
		}
		if (current === rootLimit) break
		const parent = resolve(current, "..")
		if (parent === current) break // filesystem root guard
		current = parent
	}

	// Ancestor-first ordering: root-level rules are the baseline.
	rulesDirs.reverse()

	const rules: AgentRule[] = []
	const diagnostics: RuleDiagnostic[] = []
	const seen = new Set<string>()
	for (const { dir, baseDir } of rulesDirs) {
		for (const filePath of collectRuleFiles(dir)) {
			const resolved = resolve(filePath)
			if (seen.has(resolved)) continue
			seen.add(resolved)
			const { rule, diagnostic } = loadRule(resolved, baseDir)
			if (rule) rules.push(rule)
			if (diagnostic) diagnostics.push(diagnostic)
		}
	}

	return { rules, diagnostics }
}
