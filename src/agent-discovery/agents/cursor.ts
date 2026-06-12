import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { hasBearerAuthorizationHeader } from "../engine.js"
import type { AgentDefinition } from "../index.js"

const DEFAULT_CURSOR_CONFIG_PATHS = [
	join(homedir(), ".cursor", "mcp.json"),
	join(homedir(), ".config", "cursor", "mcp.json"),
]

const DEFAULT_CURSOR_SKILLS_DIRS = [join(process.cwd(), ".cursor", "skills"), join(homedir(), ".cursor", "skills")]

interface CursorServerRaw {
	command?: string
	args?: string[]
	env?: Record<string, string>
	url?: string
	headers?: Record<string, string>
	disabled?: boolean
}

function transformCursorServer(raw: unknown): ServerEntry | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const server = raw as CursorServerRaw
	if (server.disabled === true) return undefined

	const entry: ServerEntry = {}
	if (server.command !== undefined) entry.command = server.command
	if (server.args !== undefined) entry.args = server.args
	if (server.env !== undefined) entry.env = server.env
	if (server.url !== undefined) entry.url = server.url
	if (server.headers !== undefined) {
		entry.headers = server.headers
		if (server.url && hasBearerAuthorizationHeader(server.headers)) {
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
			return transformCursorServer(raw)
		},
	}
}

export const cursor: AgentDefinition = makeCursorDefinition()
