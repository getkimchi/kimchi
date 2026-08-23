/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * Uses pi's official loadSkillsFromDir API to discover skills from kimchi's DEFAULT_SKILL_PATHS.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Skill } from "@earendil-works/pi-coding-agent"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { DEFAULT_SKILL_PATHS } from "../../../config.js"
import { isUnsafeName } from "../memory/memory.js"

export interface PreloadedSkill {
	name: string
	content: string
}

export interface ListAvailableSkillNamesOptions {
	/** Override for os.homedir(), useful for tests. Defaults to homedir(). */
	readonly homeDir?: string
}

/** One skill discovered by {@link listAvailableSkillNames}. */
export interface SkillListEntry {
	name: string
	description: string
	filePath: string
}

/**
 * Resolve kimchi's DEFAULT_SKILL_PATHS for a cwd. Absolute paths are kept as-is;
 * paths starting with ".config/" resolve under the user's home directory; all
 * others resolve relative to cwd.
 */
export function resolveSkillPaths(cwd: string, home = homedir()): string[] {
	return DEFAULT_SKILL_PATHS.map((p) => {
		if (isAbsolute(p)) {
			return p
		}
		if (p.startsWith(".config/")) {
			return join(home, p)
		}
		return join(cwd, p)
	})
}

/**
 * Discover all available skill names and descriptions from DEFAULT_SKILL_PATHS.
 * Returns a compact list of { name, description, filePath } pairs for injection
 * into sub-agent prompts when skills === true (the default).
 *
 * User custom skills (from .kimchi/skills/) are included since
 * DEFAULT_SKILL_PATHS scans all standard locations.
 */
export function listAvailableSkillNames(cwd: string, options: ListAvailableSkillNamesOptions = {}): SkillListEntry[] {
	const allSkills = new Map<string, SkillListEntry>()
	for (const dir of resolveSkillPaths(cwd, options.homeDir)) {
		try {
			const { skills } = loadSkillsFromDir({ dir, source: dir })
			for (const skill of skills) {
				allSkills.set(skill.name, {
					name: skill.name,
					description: skill.description ?? "",
					filePath: skill.filePath,
				})
			}
		} catch (err) {
			// Directory missing or unreadable — log so skill-path problems are detectable
			console.warn(`[skill-loader] Failed to list skills from ${dir}:`, err instanceof Error ? err.message : err)
		}
	}

	return Array.from(allSkills.values())
}

/**
 * Attempt to load named skills using pi's official loadSkillsFromDir for each path
 * in kimchi's DEFAULT_SKILL_PATHS. Project-level paths are resolved relative to cwd;
 * paths starting with ".config/" are resolved relative to homedir.
 *
 * @param skillNames  List of skill names to preload.
 * @param cwd         Working directory for relative path resolution.
 * @returns Array of loaded skills (missing skills return a stub note instead of throwing).
 */
export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
	if (skillNames.length === 0) return []

	const resolvedPaths = resolveSkillPaths(cwd)

	// Collect all skills from all paths using pi's official loader
	const allSkills = new Map<string, Skill>()
	for (const dir of resolvedPaths) {
		try {
			const { skills } = loadSkillsFromDir({ dir, source: dir })
			for (const skill of skills) {
				// Later paths (higher priority) override earlier ones
				allSkills.set(skill.name, skill)
			}
		} catch {
			// Directory missing or unreadable — skip silently
		}
	}

	// Map requested names to their content
	const results: PreloadedSkill[] = []
	for (const name of skillNames) {
		if (isUnsafeName(name)) {
			results.push({ name, content: `(Skill "${name}" skipped: name contains path traversal characters)` })
			continue
		}

		const skill = allSkills.get(name)
		if (!skill) {
			results.push({ name, content: `(Skill "${name}" not found in kimchi skill paths)` })
			continue
		}

		try {
			const content = readFileSync(skill.filePath, "utf-8").trim()
			results.push({ name, content })
		} catch {
			results.push({ name, content: `(Skill "${name}" found but could not be read: ${skill.filePath})` })
		}
	}

	return results
}
