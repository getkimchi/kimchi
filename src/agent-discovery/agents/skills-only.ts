import { homedir } from "node:os"
import { join } from "node:path"
import type { AgentDefinition } from "../index.js"

/**
 * Agents whose configs kimchi doesn't migrate (no MCP server schema we
 * read), but which ship skills under the converged `<dir>/skills/<name>/SKILL.md`
 * layout. The migration wizard scans these so a user running several agents
 * sees every skills directory called out, not just Claude Code and OpenCode.
 *
 * Each entry scans the project-local dir first (these conventions are mostly
 * repo-relative, e.g. `.github/skills`, `.agents/skills`) then the global
 * `~/<dir>/skills` fallback. First existing directory wins, matching the
 * Claude Code / OpenCode discoverers.
 */
export function makeSkillsOnlyAgent(
	id: string,
	displayName: string,
	dir: string,
	overrides?: { skillsDirs?: string[] },
): AgentDefinition {
	const skillsDirs = overrides?.skillsDirs ?? [join(process.cwd(), dir, "skills"), join(homedir(), dir, "skills")]
	return {
		id,
		displayName,
		configPaths: [],
		skillsDirs,
		commandsDirs: [],
		extractServerSources: () => [],
		transformServer: () => undefined,
	}
}

/** Converged skills directories beyond the agents that have full migrators. */
const SKILLS_ONLY_DIRS: ReadonlyArray<{ id: string; displayName: string; dir: string }> = [
	{ id: "codex", displayName: "Codex", dir: ".codex" },
	{ id: "warp", displayName: "Warp", dir: ".warp" },
	{ id: "factory", displayName: "Factory (Droid)", dir: ".factory" },
	{ id: "gemini", displayName: "Gemini", dir: ".gemini" },
	{ id: "copilot", displayName: "Copilot", dir: ".copilot" },
	{ id: "github", displayName: "GitHub", dir: ".github" },
	{ id: "agents", displayName: "Agents", dir: ".agents" },
]

export const SKILLS_ONLY_AGENTS: readonly AgentDefinition[] = SKILLS_ONLY_DIRS.map((a) =>
	makeSkillsOnlyAgent(a.id, a.displayName, a.dir),
)
