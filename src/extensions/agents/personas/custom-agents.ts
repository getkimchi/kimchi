/**
 * custom-agents.ts — Load user-defined agents from project, global, and installed-extension locations.
 *
 * Discovery hierarchy (later overwrites earlier):
 *   1. Package: each installed kimchi extension's <pkg>/agents/*.md (lowest)
 *   2. Global:  $KIMCHI_CODING_AGENT_DIR/agents/*.md (default: ~/.config/kimchi/harness/agents/*.md)
 *   3. Project: <cwd>/.kimchi/agents/*.md (highest — overrides everything)
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent"
import { getInstalledPackageResourceDirs } from "../package-resources.js"
import { BUILTIN_TOOL_NAMES } from "./agent-types.js"
import type { AgentConfig, MemoryScope, ThinkingLevel } from "./types.js"

/**
 * Scan for custom agent .md files from multiple locations.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
	const globalDir = join(getAgentDir(), "agents")
	const projectDir = join(cwd, ".kimchi", "agents")

	const agentsMap = new Map<string, AgentConfig>()
	for (const pkgDir of getInstalledPackageResourceDirs(cwd, "agents")) {
		loadFromDir(pkgDir, agentsMap, "package") // lowest priority
	}
	loadFromDir(globalDir, agentsMap, "global") // overrides package
	loadFromDir(projectDir, agentsMap, "project") // overrides everything
	return agentsMap
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agentsMap: Map<string, AgentConfig>, source: "project" | "global" | "package"): void {
	if (!existsSync(dir)) return

	let files: string[]
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"))
	} catch {
		return
	}

	for (const file of files) {
		const name = basename(file, ".md")

		let content: string
		try {
			content = readFileSync(join(dir, file), "utf-8")
		} catch {
			continue
		}

		const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content)

		agentsMap.set(name, {
			name,
			displayName: str(fm.display_name),
			description: str(fm.description) ?? name,
			builtinToolNames: csvList(fm.tools, BUILTIN_TOOL_NAMES),
			disallowedTools: csvListOptional(fm.disallowed_tools),
			extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
			skills: inheritField(fm.skills ?? fm.inherit_skills),
			models: modelToArray(fm),
			thinking: str(fm.thinking) as ThinkingLevel | undefined,
			maxTurns: nonNegativeInt(fm.max_turns),
			tokenBudget: positiveInt(fm.token_budget),
			maxDuration: positiveInt(fm.max_duration),
			systemPrompt: body.trim(),
			promptMode: fm.prompt_mode === "append" ? "append" : "replace",
			inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,
			runInBackground: fm.run_in_background != null ? fm.run_in_background === true : undefined,
			isolated: fm.isolated != null ? fm.isolated === true : undefined,
			memory: parseMemory(fm.memory),
			isolation: fm.isolation === "worktree" ? "worktree" : undefined,
			enabled: fm.enabled !== false,
			source,
		})
	}
}

// ---- Field parsers ----

function str(val: unknown): string | undefined {
	return typeof val === "string" ? val : undefined
}

function nonNegativeInt(val: unknown): number | undefined {
	return typeof val === "number" && val >= 0 ? val : undefined
}

function positiveInt(val: unknown): number | undefined {
	const n = nonNegativeInt(val)
	return n != null && n > 0 ? n : undefined
}

function parseCsvField(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined
	const s = String(val).trim()
	if (!s || s === "none") return undefined
	const items = s
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean)
	return items.length > 0 ? items : undefined
}

function csvList(val: unknown, defaults: string[]): string[] {
	if (val === undefined || val === null) return defaults
	return parseCsvField(val) ?? []
}

function csvListOptional(val: unknown): string[] | undefined {
	return parseCsvField(val)
}

function modelToArray(fm: Record<string, unknown>): string[] | undefined {
	// New form: `models: [...]` (preferred)
	const arr = csvOrArrayList(fm.models)
	if (arr) return arr
	// Legacy form: `model: "x"` → wrap as single-element array
	const single = str(fm.model)
	if (single && single !== "inherit") return [single]
	return undefined
}

function csvOrArrayList(val: unknown): string[] | undefined {
	if (Array.isArray(val) && val.every((v) => typeof v === "string" && v.length > 0)) {
		return val as string[]
	}
	if (typeof val === "string" && val.trim().length > 0) {
		return parseCsvField(val)
	}
	return undefined
}

function parseMemory(val: unknown): MemoryScope | undefined {
	if (val === "user" || val === "project" || val === "local") return val
	return undefined
}

function inheritField(val: unknown): true | string[] | false {
	if (val === undefined || val === null || val === true) return true
	if (val === false || val === "none") return false
	const items = csvList(val, [])
	return items.length > 0 ? items : false
}
