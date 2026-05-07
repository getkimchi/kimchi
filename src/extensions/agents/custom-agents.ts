/**
 * custom-agents.ts — Load user-defined agents from project (.kimchi/agents/) and global ($KIMCHI_CODING_AGENT_DIR/agents/) locations.
 *
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.kimchi/agents/*.md
 *   2. Global:  $KIMCHI_CODING_AGENT_DIR/agents/*.md (default: ~/.config/kimchi/harness/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent"
import { BUILTIN_TOOL_NAMES } from "./agent-types.js"
import type { AgentConfig, MemoryScope, ThinkingLevel } from "./types.js"

/**
 * Scan for custom agent .md files from multiple locations.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
	const globalDir = join(getAgentDir(), "agents")
	const projectDir = join(cwd, ".kimchi", "agents")

	const agentsMap = new Map<string, AgentConfig>()
	loadFromDir(globalDir, agentsMap, "global") // lower priority
	loadFromDir(projectDir, agentsMap, "project") // higher priority (overwrites)
	return agentsMap
}

/** Load agent configs from a directory into the map. */
function loadFromDir(dir: string, agentsMap: Map<string, AgentConfig>, source: "project" | "global"): void {
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
			model: str(fm.model),
			thinking: str(fm.thinking) as ThinkingLevel | undefined,
			maxTurns: nonNegativeInt(fm.max_turns),
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
