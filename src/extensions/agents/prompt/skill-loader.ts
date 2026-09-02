/**
 * skill-loader.ts — Preload specific skill files and inject their content into the system prompt.
 *
 * Uses pi's official loadSkillsFromDir API to discover skills from the central
 * skill-root resolver (src/shared/skill-discovery) — bundled (shipped with the
 * harness), harness-home, config, and project (.kimchi/skills) roots, weakest first.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import type { Skill } from "@earendil-works/pi-coding-agent"
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent"
import { resolveSkillRoots } from "../../../shared/skill-discovery/resolve-skill-roots.js"
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
 * Resolve the ordered skill root directories for a cwd, weakest first
 * (bundled, harness, config, project). Delegates to the central resolver in
 * src/shared/skill-discovery so every consumer agrees on locations and
 * precedence. Discovered skills are still loaded per-directory with
 * loadSkillsFromDir; later dirs override earlier ones on name collisions.
 */
export function resolveSkillPaths(cwd: string, home = homedir()): string[] {
	return resolveSkillRoots({ cwd, homeDir: home }).map((root) => root.dir)
}

/**
 * Discover all available skill names and descriptions from the resolved skill
 * roots (bundled, harness, config, and project `.kimchi/skills`).
 * Returns a compact list of { name, description, filePath } pairs for injection
 * into sub-agent prompts when skills === true (the default).
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
 * Attempt to load named skills using pi's official loadSkillsFromDir across the
 * resolved skill roots (bundled, harness, config, project); later roots
 * override earlier ones on name collisions.
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
