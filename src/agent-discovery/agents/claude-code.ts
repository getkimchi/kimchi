import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { hasBearerAuthorizationHeader } from "../engine.js"
import type { AgentDefinition } from "../index.js"

const CC_CONFIG_PATH = join(homedir(), ".claude.json")
const CC_SKILLS_DIR = join(homedir(), ".claude", "skills")

interface CcServerRaw {
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	header?: Record<string, string>
	headers?: Record<string, string>
	type?: string
}

function makeTransformServer(raw: CcServerRaw): ServerEntry {
	const entry: ServerEntry = {}
	if (raw.command !== undefined) entry.command = raw.command
	if (raw.args !== undefined) entry.args = raw.args
	if (raw.env !== undefined) entry.env = raw.env
	if (raw.cwd !== undefined) entry.cwd = raw.cwd
	if (raw.url !== undefined) entry.url = raw.url
	const headers = raw.headers ?? raw.header
	if (headers !== undefined) entry.headers = headers
	if (
		raw.url !== undefined &&
		headers !== null &&
		typeof headers === "object" &&
		hasBearerAuthorizationHeader(headers)
	) {
		entry.auth = "bearer"
	}
	return entry
}

export function makeClaudeCodeDefinition(overrides?: {
	configPaths?: string[]
	skillsDirs?: string[]
}): AgentDefinition {
	const configPaths = overrides?.configPaths ?? [CC_CONFIG_PATH]
	const skillsDirs = overrides?.skillsDirs ?? [CC_SKILLS_DIR]

	return {
		id: "claude-code",
		displayName: "Claude Code",
		configPaths,
		skillsDirs,

		extractServerSources(parsed) {
			if (!parsed || typeof parsed !== "object") return []
			const root = parsed as Record<string, unknown>
			const sources: Array<Record<string, unknown>> = []
			// Project blocks first → project entries win over top-level on conflict.
			const projects = root.projects
			if (projects && typeof projects === "object" && !Array.isArray(projects)) {
				for (const project of Object.values(projects as Record<string, unknown>)) {
					const ms = (project as Record<string, unknown> | null)?.mcpServers
					if (ms && typeof ms === "object" && !Array.isArray(ms)) {
						sources.push(ms as Record<string, unknown>)
					}
				}
			}
			const top = root.mcpServers
			if (top && typeof top === "object" && !Array.isArray(top)) {
				sources.push(top as Record<string, unknown>)
			}
			return sources
		},

		transformServer(raw, _name) {
			return makeTransformServer(raw as CcServerRaw)
		},
	}
}

export const claudeCode: AgentDefinition = makeClaudeCodeDefinition()
