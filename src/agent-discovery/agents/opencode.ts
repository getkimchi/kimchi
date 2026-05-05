import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "../../extensions/mcp-adapter/types.js"
import { hasBearerAuthorizationHeader } from "../engine.js"
import type { AgentDefinition } from "../index.js"
import { parseJsonc } from "../jsonc.js"

type SchemaHint = "modern" | "legacy"

const DEFAULT_OC_CONFIG_PATHS = (() => {
	const home = homedir()
	const envOverride = process.env.OPENCODE_CONFIG
	return [
		...(envOverride ? [envOverride] : []),
		join(home, ".config", "opencode", "opencode.json"),
		join(home, ".config", "opencode", "opencode.jsonc"),
		join(home, ".config", "opencode", "config.json"),
		join(home, ".opencode.json"),
	]
})()

const DEFAULT_OC_SKILLS_DIRS = [
	join(homedir(), ".config", "opencode", "skills"),
	join(homedir(), ".config", "opencode", "skill"),
]

interface ModernServerRaw {
	type?: string
	command?: string[]
	environment?: Record<string, string>
	url?: string
	headers?: Record<string, string>
	enabled?: boolean
}

interface LegacyServerRaw {
	type?: string
	command?: string
	args?: string[]
	env?: Record<string, string> | string[]
	url?: string
	headers?: Record<string, string>
}

function normaliseLegacyEnv(env: unknown): Record<string, string> | undefined {
	if (!env) return undefined
	if (typeof env === "object" && !Array.isArray(env)) {
		return env as Record<string, string>
	}
	if (Array.isArray(env)) {
		const result: Record<string, string> = {}
		for (const item of env) {
			if (typeof item !== "string") continue
			const eq = item.indexOf("=")
			if (eq > 0) {
				result[item.slice(0, eq)] = item.slice(eq + 1)
			}
		}
		return Object.keys(result).length > 0 ? result : undefined
	}
	return undefined
}

function transformModernServer(raw: ModernServerRaw): ServerEntry | undefined {
	if (raw.enabled === false) {
		return undefined
	}

	const entry: ServerEntry = {}

	if (raw.command !== undefined) {
		if (!Array.isArray(raw.command) || raw.command.length === 0) {
			return undefined
		}
		entry.command = raw.command[0]
		if (raw.command.length > 1) {
			entry.args = raw.command.slice(1)
		}
	}

	if (raw.environment !== undefined) {
		entry.env = raw.environment
	}

	if (raw.url !== undefined) {
		entry.url = raw.url
	}

	if (raw.headers !== undefined) {
		entry.headers = raw.headers
		if (raw.url && hasBearerAuthorizationHeader(raw.headers)) {
			entry.auth = "bearer"
		}
	}

	return entry
}

function transformLegacyServer(raw: LegacyServerRaw): ServerEntry {
	const entry: ServerEntry = {}

	if (raw.command !== undefined) entry.command = raw.command
	if (raw.args !== undefined) entry.args = raw.args
	if (raw.env !== undefined) entry.env = normaliseLegacyEnv(raw.env)
	if (raw.url !== undefined) entry.url = raw.url
	if (raw.headers !== undefined) {
		entry.headers = raw.headers
		if (raw.url && hasBearerAuthorizationHeader(raw.headers)) {
			entry.auth = "bearer"
		}
	}

	return entry
}

export function makeOpenCodeDefinition(overrides?: {
	configPaths?: string[]
	skillsDirs?: string[]
}): AgentDefinition {
	const configPaths = overrides?.configPaths ?? DEFAULT_OC_CONFIG_PATHS
	const skillsDirs = overrides?.skillsDirs ?? DEFAULT_OC_SKILLS_DIRS

	return {
		id: "opencode",
		displayName: "OpenCode",
		configPaths,
		skillsDirs,
		parseConfig: parseJsonc,

		extractServerSources(parsed) {
			if (!parsed || typeof parsed !== "object") return []
			const root = parsed as Record<string, unknown>
			const sources: Array<{ entries: Record<string, unknown>; meta: SchemaHint }> = []
			// Modern shape first; legacy after — modern wins on name collision.
			if (root.mcp && typeof root.mcp === "object" && !Array.isArray(root.mcp)) {
				sources.push({ entries: root.mcp as Record<string, unknown>, meta: "modern" })
			}
			if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
				sources.push({ entries: root.mcpServers as Record<string, unknown>, meta: "legacy" })
			}
			return sources
		},

		transformServer(raw, _name, meta) {
			if (meta === "modern") return transformModernServer(raw as ModernServerRaw)
			return transformLegacyServer(raw as LegacyServerRaw)
		},
	}
}

export const openCode: AgentDefinition = makeOpenCodeDefinition()
