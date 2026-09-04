import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { loadMcpConfig as loadUpstreamMcpConfig } from "pi-mcp-adapter/config"
import type { ImportKind, McpConfig, McpSettings, ServerEntry } from "pi-mcp-adapter/types"
import { readJson } from "../../config/json.js"

export const LEGACY_PROJECT_MCP_CONFIG = ".kimchi/mcp.json"

export interface KimchiMcpConfigResult {
	config: McpConfig
	configPath?: string
	useProgrammaticConfig?: boolean
	warnings: string[]
}

const IMPORT_KINDS = new Set<string>([
	"cursor",
	"claude-code",
	"claude-desktop",
	"codex",
	"opencode",
	"windsurf",
	"vscode",
])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerEntry(value: unknown): value is ServerEntry {
	return isRecord(value)
}

function isMcpSettings(value: unknown): value is McpSettings {
	return isRecord(value)
}

function isImportKind(value: unknown): value is ImportKind {
	return typeof value === "string" && IMPORT_KINDS.has(value)
}

function loadSelectedConfig(configPath: string): { config: McpConfig; warnings: string[] } {
	if (!existsSync(configPath)) return { config: { mcpServers: {} }, warnings: [] }
	try {
		const raw = readJson(configPath)
		const rawServers = raw.mcpServers ?? raw["mcp-servers"]
		const mcpServers: Record<string, ServerEntry> = {}
		if (isRecord(rawServers)) {
			for (const [name, entry] of Object.entries(rawServers)) {
				if (isServerEntry(entry)) mcpServers[name] = entry
			}
		}
		const imports = Array.isArray(raw.imports) ? raw.imports.filter(isImportKind) : undefined
		const settings = isMcpSettings(raw.settings) ? raw.settings : undefined
		return {
			config: {
				mcpServers,
				...(imports === undefined ? {} : { imports }),
				...(settings === undefined ? {} : { settings }),
			},
			warnings: [],
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return {
			config: { mcpServers: {} },
			warnings: [`Failed to load selected MCP config from ${configPath}: ${message}`],
		}
	}
}

function applySelectedPrecedence(discovered: McpConfig, selected: McpConfig): McpConfig {
	const imports = selected.imports ?? discovered.imports
	const settings = selected.settings ? { ...discovered.settings, ...selected.settings } : discovered.settings
	return {
		mcpServers: { ...discovered.mcpServers, ...selected.mcpServers },
		...(imports === undefined ? {} : { imports }),
		...(settings === undefined ? {} : { settings }),
	}
}

export function loadKimchiMcpConfig(options: { cwd?: string; overridePath?: string } = {}): KimchiMcpConfigResult {
	const cwd = options.cwd ?? process.cwd()
	const exclusiveMode = process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive"
	const legacyPath = resolve(cwd, LEGACY_PROJECT_MCP_CONFIG)
	const configPath = options.overridePath ?? (!exclusiveMode && existsSync(legacyPath) ? legacyPath : undefined)
	const discovered = loadUpstreamMcpConfig(configPath, cwd)
	if (!configPath) return { config: discovered, warnings: [] }

	// pi-mcp-adapter treats configPath as a global layer, below its standard
	// project files. Kimchi historically treats an explicit or legacy project
	// config as authoritative, so reapply just that selected layer last. Stay in
	// file-backed mode when this does not change the effective configuration.
	const selected = loadSelectedConfig(configPath)
	const config = applySelectedPrecedence(discovered, selected.config)
	const useProgrammaticConfig = !isDeepStrictEqual(config, discovered)

	return {
		config,
		configPath,
		...(useProgrammaticConfig ? { useProgrammaticConfig: true } : {}),
		warnings: selected.warnings,
	}
}
