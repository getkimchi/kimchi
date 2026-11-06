import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { AgentDefinition, DirCandidate } from "../index.js"
import { type CcServerRaw, makeTransformServer } from "./claude-code.js"

/**
 * Claude Desktop (Chat / Cowork / Code) as a migration import source.
 * One application, three disjoint local artifacts:
 *
 * 1. `<support>/claude_desktop_config.json` — the MCP servers the app runs
 *    for every session. The support directory is per-platform:
 *      - macOS:   ~/Library/Application Support/Claude
 *      - Windows: %APPDATA%\Claude (~/AppData/Roaming fallback)
 *      - Linux:   $XDG_CONFIG_HOME/Claude (~/.config default — Desktop beta,
 *        Ubuntu 22.04+/Debian 12+ since 2026-06-30)
 *    `~/.claude/claude_desktop_config.json` is kept as a legacy fallback.
 *
 * 2. `<support>/local-agent-mode-sessions/skills-plugin/<id>/<id>/skills/<name>/SKILL.md`
 *    — account-level skills (the claude.ai "Customize" set) the Desktop
 *    materializes for local agent sessions. Unlike terminal Claude Code,
 *    Desktop sessions never write to `~/.claude/skills/synced/`: this tree
 *    is the on-disk realization of account skills. Ids vary per account, so
 *    paths come from a bounded directory scan at definition creation, the
 *    same way claude-code freezes homedir()-based paths at module load.
 *
 * 3. local-agent-mode-sessions/<id> ... rpm/plugin_<pluginId>/ tree —
 *    installed plugins, each with its own "skills" directory and an
 *    optional mcp.json: a second, runtime-only MCP source that never
 *    appears in claude_desktop_config.json.
 *
 * Both scans collect every directory literally named `skills` within a
 * bounded depth under local-agent-mode-sessions, so uuid-layout variance
 * (one vs two intermediate id segments, rpm at either depth) is tolerated.
 * The engine scans each existing root because this definition declares
 * `mergeAllSkillsDirs`: the app has several disjoint skill roots, unlike
 * the single-claude-code ~/.claude/skills convention.
 *
 * Source paths were checked against a live Claude Desktop installation on
 * macOS, plus the per-platform locations the app documents.
 */

/** Directory that holds Claude Desktop's local state, per platform. */
export function desktopSupportDir(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === "darwin") return join(home, "Library", "Application Support", "Claude")
	if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude")
	return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Claude")
}

function listSubdirs(absDir: string): string[] {
	try {
		return readdirSync(absDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(absDir, e.name))
	} catch {
		return []
	}
}

/**
 * Collect every directory literally named "skills" within `maxDepth` levels
 * under `root`. Covers skills-plugin/<a>/<b>/skills and .../rpm/plugin_<id>/skills variants with one mechanic. De-duplicated by path.
 */
function collectNamedDirs(root: string, wanted: string, maxDepth: number): string[] {
	const out = new Set<string>()
	const walk = (dir: string, depth: number): void => {
		if (depth > maxDepth || !existsSync(dir)) return
		for (const child of listSubdirs(dir)) {
			if (basename(child) === wanted) {
				out.add(child)
				continue
			}
			walk(child, depth + 1)
		}
	}
	walk(root, 0)
	return [...out]
}

/**
 * Skills roots of a Desktop install: every `skills` directory under
 * local-agent-mode-sessions (account-skills bundle + rpm plugins).
 */
export function scanDesktopSkillDirs(supportDir: string): string[] {
	return collectNamedDirs(join(supportDir, "local-agent-mode-sessions"), "skills", 5)
}

/**
 * Extra MCP config files from installed rpm plugins: `mcp.json` next to the
 * plugin's manifest, in the root or one of the dot-prefixed manifest blocks
 * third-party plugins ship with.
 */
export function scanDesktopPluginConfigs(supportDir: string): string[] {
	const sessions = join(supportDir, "local-agent-mode-sessions")
	const rpmDirs = collectNamedDirs(sessions, "rpm", 4)
	const configs = new Set<string>()
	for (const rpmDir of rpmDirs) {
		for (const pluginDir of listSubdirs(rpmDir)) {
			for (const rel of ["mcp.json", join(".cursor-plugin", "mcp.json"), join(".claude-plugin", "mcp.json")]) {
				const candidate = join(pluginDir, rel)
				if (existsSync(candidate)) configs.add(candidate)
			}
		}
	}
	return [...configs]
}

const LEGACY_CONFIG_PATH = join(homedir(), ".claude", "claude_desktop_config.json")

export function makeClaudeDesktopDefinition(overrides?: {
	configPaths?: string[]
	skillsDirs?: DirCandidate[]
	supportDir?: string
}): AgentDefinition {
	const supportDir = overrides?.supportDir ?? desktopSupportDir()
	return {
		id: "claude-desktop",
		displayName: "Claude Desktop",
		configPaths: overrides?.configPaths ?? [
			join(supportDir, "claude_desktop_config.json"),
			LEGACY_CONFIG_PATH,
			...scanDesktopPluginConfigs(supportDir),
		],
		skillsDirs: overrides?.skillsDirs ?? scanDesktopSkillDirs(supportDir),
		commandsDirs: [],
		// Desktop materializes account skills and plugin skills in disjoint
		// roots — all of them belong to one import surface, so every existing
		// scanned dir must be merged, not just the first.
		mergeAllSkillsDirs: true,

		extractServerSources(parsed) {
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
			const top = (parsed as Record<string, unknown>).mcpServers
			if (!top || typeof top !== "object" || Array.isArray(top)) return []
			return [top as Record<string, unknown>]
		},

		// Desktop's claude_desktop_config.json and plugin mcp.json both use the
		// conventional MCP entry schema (command/args/env/url/headers), so the
		// Claude Code normalizer applies verbatim, including bearer-flag
		// detection from an Authorization header.
		transformServer(raw) {
			return makeTransformServer(raw as CcServerRaw)
		},
	}
}

export const claudeDesktop: AgentDefinition = makeClaudeDesktopDefinition()
