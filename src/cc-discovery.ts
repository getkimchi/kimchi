import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ServerEntry } from "./extensions/mcp-adapter/types.js"

const CC_CONFIG_PATH = join(homedir(), ".claude.json")
const CC_SKILLS_DIR = join(homedir(), ".claude", "skills")

export interface CcDiscovery {
	mcpServers: Record<string, ServerEntry>
	skillCount: number
	skillsDir?: string
}

interface CcMcpServerRaw {
	type?: string
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	header?: Record<string, string>
	headers?: Record<string, string>
	[key: string]: unknown
}

function transformServer(raw: CcMcpServerRaw): ServerEntry {
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

function hasBearerAuthorizationHeader(headers: Record<string, string>): boolean {
	return Object.entries(headers).some(
		([k, v]) => k.toLowerCase() === "authorization" && typeof v === "string" && v.toLowerCase().startsWith("bearer "),
	)
}

function ingestServers(into: Record<string, ServerEntry>, source: unknown): void {
	if (!source || typeof source !== "object" || Array.isArray(source)) return
	for (const [name, def] of Object.entries(source as Record<string, unknown>)) {
		if (into[name]) continue
		if (def === null || typeof def !== "object" || Array.isArray(def)) continue
		into[name] = transformServer(def as CcMcpServerRaw)
	}
}

export function discoverCcConfig(
	configPath = CC_CONFIG_PATH,
	opts?: {
		skillsDirs?: string[]
	},
): CcDiscovery {
	const mcpServers: Record<string, ServerEntry> = {}

	try {
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		const projects = raw?.projects
		if (projects && typeof projects === "object") {
			for (const project of Object.values(projects)) {
				ingestServers(mcpServers, (project as Record<string, unknown>)?.mcpServers)
			}
		}

		ingestServers(mcpServers, raw?.mcpServers)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn(`Failed to read Claude Code config: ${err instanceof Error ? err.message : String(err)}`)
		}
	}

	let skillCount = 0
	let skillsDir: string | undefined
	const skillsDirs = opts?.skillsDirs ?? [CC_SKILLS_DIR]
	for (const dir of skillsDirs) {
		if (existsSync(dir)) {
			skillsDir = dir
			try {
				skillCount = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
			} catch (err) {
				console.warn(`Failed to read Claude Code skills directory: ${err instanceof Error ? err.message : String(err)}`)
			}
			break
		}
	}

	return { mcpServers, skillCount, skillsDir }
}
