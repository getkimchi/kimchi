import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { hasBearerAuthorizationHeader } from "../engine.js"
import type { AgentDefinition } from "../index.js"

const DEFAULT_CURSOR_CONFIG_PATHS = [
	join(homedir(), ".cursor", "mcp.json"),
	join(homedir(), ".config", "cursor", "mcp.json"),
]

const DEFAULT_CURSOR_SKILLS_DIRS = [join(homedir(), ".cursor", "skills"), join(homedir(), ".agents", "skills")]

interface CursorServerRaw {
	command?: string
	args?: string[]
	env?: Record<string, string>
	url?: string
	headers?: Record<string, string>
	type?: string
	disabled?: boolean
}

function transformCursorServer(raw: CursorServerRaw): ServerEntry | undefined {
	if (raw.disabled === true) return undefined

	const entry: ServerEntry = {}
	if (raw.command !== undefined) entry.command = raw.command
	if (raw.args !== undefined) entry.args = raw.args
	if (raw.env !== undefined) entry.env = raw.env
	if (raw.url !== undefined) entry.url = raw.url
	if (raw.headers !== undefined) {
		entry.headers = raw.headers
		if (raw.url && hasBearerAuthorizationHeader(raw.headers)) {
			entry.auth = "bearer"
		}
	}

	if (entry.command === undefined && entry.url === undefined) return undefined
	return entry
}

export function makeCursorDefinition(overrides?: {
	configPaths?: string[]
	skillsDirs?: string[]
}): AgentDefinition {
	const configPaths = overrides?.configPaths ?? DEFAULT_CURSOR_CONFIG_PATHS
	const skillsDirs = overrides?.skillsDirs ?? DEFAULT_CURSOR_SKILLS_DIRS

	return {
		id: "cursor",
		displayName: "Cursor",
		configPaths,
		skillsDirs,
		commandsDirs: [],

		extractServerSources(parsed) {
			if (!parsed || typeof parsed !== "object") return []
			const root = parsed as Record<string, unknown>
			const top = root.mcpServers
			if (top && typeof top === "object" && !Array.isArray(top)) {
				return [top as Record<string, unknown>]
			}
			return []
		},

		transformServer(raw, _name) {
			return transformCursorServer(raw as CursorServerRaw)
		},
	}
}

export const cursor: AgentDefinition = makeCursorDefinition()
