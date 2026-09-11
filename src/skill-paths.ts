import { join } from "node:path"
import { findNearestAncestorPath } from "./utils/find-nearest-ancestor.js"

/**
 * Return the nearest ancestor `.kimchi/skills` directory for the given cwd.
 *
 * The ancestor search is unconditional: Kimchi treats project-local skills as
 * trusted resources, matching how Pi itself bypasses trust for top-level
 * extension-contributed paths. Callers that want a stricter scope should filter
 * the result.
 */
export function getKimchiProjectSkillPaths(cwd = process.cwd()): string[] {
	const skillsDir = findNearestAncestorPath(cwd, join(".kimchi", "skills"))
	return skillsDir ? [skillsDir] : []
}
