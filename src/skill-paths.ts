import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * Return the nearest ancestor `.kimchi/skills` directory for the given cwd.
 *
 * The ancestor search is unconditional: Kimchi treats project-local skills as
 * trusted resources, matching how Pi itself bypasses trust for top-level
 * extension-contributed paths. Callers that want a stricter scope should filter
 * the result.
 */
export function getKimchiProjectSkillPaths(cwd = process.cwd()): string[] {
	const skillsDir = findNearestAncestorSkillDir(cwd, join(".kimchi", "skills"))
	return skillsDir ? [skillsDir] : []
}

/**
 * Walk from `cwd` up to the filesystem root looking for `relativeSkillDir`.
 * Intentionally not gated on trust flags — project-local skill roots are
 * treated as part of the workspace, analogous to Pi's own project resource
 * discovery.
 */
export function findNearestAncestorSkillDir(cwd: string, relativeSkillDir: string): string | undefined {
	let dir = resolve(cwd)
	while (true) {
		const skillDir = join(dir, relativeSkillDir)
		if (existsSync(skillDir)) return skillDir
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}
