import { join } from "node:path"
import { isProjectScopeAllowed } from "./project-scope-trust.js"
import { findNearestAncestorPath } from "./utils/find-nearest-ancestor.js"

/**
 * Return the nearest ancestor `.kimchi/skills` directory for the given cwd.
 *
 * The result is gated on project trust (src/project-scope-trust.ts): while
 * the cwd is untrusted, no project skill directory is returned — a cloned
 * repo's skills must not reach the system prompt before the folder is
 * trusted. Callers wanting a stricter scope should filter the result.
 */
export function getKimchiProjectSkillPaths(cwd = process.cwd()): string[] {
	if (!isProjectScopeAllowed(cwd)) return []
	const skillsDir = findNearestAncestorPath(cwd, join(".kimchi", "skills"))
	return skillsDir ? [skillsDir] : []
}
