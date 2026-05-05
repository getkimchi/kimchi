import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "./extensions/mcp-adapter/types.js"

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

export interface OcDiscovery {
	mcpServers: Record<string, ServerEntry>
	skillCount: number
	skillsDir?: string
}

interface ModernServerRaw {
	type?: string
	command?: string[]
	environment?: Record<string, string>
	url?: string
	headers?: Record<string, string>
	enabled?: boolean
	[key: string]: unknown
}

interface LegacyServerRaw {
	type?: string
	command?: string
	args?: string[]
	env?: Record<string, string> | string[]
	url?: string
	headers?: Record<string, string>
	[key: string]: unknown
}

// Minimal JSONC parser: strips // line comments and /* … */ block comments,
// but respects string literals so "//" inside "https://…" survives.
// Does not support trailing commas (matches JSON.parse constraint).
function parseJsonc(raw: string): unknown {
	let result = ""
	let i = 0
	const len = raw.length

	while (i < len) {
		const ch = raw[i]

		if (ch === '"') {
			// String literal — copy verbatim
			result += ch
			i++
			while (i < len) {
				const c = raw[i]
				result += c
				i++
				if (c === "\\") {
					// Escape sequence — copy one more char
					if (i < len) {
						result += raw[i]
						i++
					}
				} else if (c === '"') {
					break
				}
			}
		} else if (ch === "/" && i + 1 < len && raw[i + 1] === "/") {
			// Line comment — skip to end of line
			while (i < len && raw[i] !== "\n" && raw[i] !== "\r") {
				i++
			}
		} else if (ch === "/" && i + 1 < len && raw[i + 1] === "*") {
			// Block comment — skip until */
			i += 2
			while (i < len) {
				if (raw[i] === "*" && i + 1 < len && raw[i + 1] === "/") {
					i += 2
					break
				}
				i++
			}
		} else {
			result += ch
			i++
		}
	}

	return JSON.parse(result)
}

function hasBearerAuthorizationHeader(headers: Record<string, string>): boolean {
	return Object.entries(headers).some(
		([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string" && v.toLowerCase().startsWith("bearer "),
	)
}

function transformModernServer(name: string, raw: ModernServerRaw): ServerEntry | undefined {
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

function ingestModern(into: Record<string, ServerEntry>, source: unknown): void {
	if (!source || typeof source !== "object" || Array.isArray(source)) return
	for (const [name, def] of Object.entries(source as Record<string, unknown>)) {
		if (into[name]) continue
		if (def === null || typeof def !== "object" || Array.isArray(def)) continue
		const entry = transformModernServer(name, def as ModernServerRaw)
		if (entry) into[name] = entry
	}
}

function ingestLegacy(into: Record<string, ServerEntry>, source: unknown): void {
	if (!source || typeof source !== "object" || Array.isArray(source)) return
	for (const [name, def] of Object.entries(source as Record<string, unknown>)) {
		if (into[name]) continue
		if (def === null || typeof def !== "object" || Array.isArray(def)) continue
		into[name] = transformLegacyServer(def as LegacyServerRaw)
	}
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function discoverOcConfig(opts?: {
	configPaths?: string[]
	skillsDirs?: string[]
}): OcDiscovery {
	const configPaths = opts?.configPaths ?? DEFAULT_OC_CONFIG_PATHS
	const skillsDirs = opts?.skillsDirs ?? DEFAULT_OC_SKILLS_DIRS
	const mcpServers: Record<string, ServerEntry> = {}

	for (const path of configPaths) {
		let raw: string
		try {
			raw = readFileSync(path, "utf-8")
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Failed to read OpenCode config at ${path}: ${msg(err)}`)
			}
			continue
		}
		let parsed: unknown
		try {
			parsed = parseJsonc(raw)
		} catch (err) {
			console.warn(`Failed to parse OpenCode config at ${path}: ${msg(err)}`)
			continue
		}
		if (parsed && typeof parsed === "object") {
			ingestModern(mcpServers, (parsed as Record<string, unknown>).mcp)
			ingestLegacy(mcpServers, (parsed as Record<string, unknown>).mcpServers)
		}
		break // first readable & parseable file wins
	}

	let skillCount = 0
	let skillsDir: string | undefined
	for (const dir of skillsDirs) {
		if (existsSync(dir)) {
			skillsDir = dir
			try {
				skillCount = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
			} catch (err) {
				console.warn(`Failed to read OpenCode skills directory at ${dir}: ${msg(err)}`)
			}
			break
		}
	}

	return { mcpServers, skillCount, skillsDir }
}
