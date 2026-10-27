import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { loadMcpConfig as loadUpstreamMcpConfig, setPiMcpConfigEnabled } from "pi-mcp-adapter/config"
import type { ImportKind, McpConfig, McpSettings, ServerEntry } from "pi-mcp-adapter/types"
import stripJsonComments from "strip-json-comments"

// Kimchi always runs on Pi >= 0.99, whose native MCP config lives in `mcp.json`.
// The adapter only reads those legacy layers once its own extension init has
// detected the Pi version; Kimchi's loader can run before that init, so enable
// the compat layer up front (same decision the adapter would make moments later).
setPiMcpConfigEnabled(true)

export const LEGACY_PROJECT_MCP_CONFIG = ".kimchi/mcp.json"

/** Filename of the user-global MCP config kimchi shares with kimchi-studio. */
export const SHARED_MCP_CONFIG_FILENAME = "mcp.json"

/**
 * The user-global MCP config kimchi shares with kimchi-studio's bundled
 * harness (`~/.config/kimchi/harness/mcp.json`). Passed to createMcpAdapter()
 * as the default configPath so every adapter write flow (compat imports, Jev
 * settings, user-kind write-backs) lands in the file Studio reads — the same
 * single global file the 2.x adapter used before upstream moved to
 * `mcp-adapter.json`.
 */
export function getSharedMcpConfigPath(): string {
	return join(getAgentDir(), SHARED_MCP_CONFIG_FILENAME)
}

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
		const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8"), { trailingCommas: true }))
		if (!isRecord(parsed)) throw new Error("MCP config must be a JSON object")
		const raw = parsed
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

export function loadKimchiMcpConfig(
	options: { cwd?: string; overridePath?: string; includeProjectSources?: boolean } = {},
): KimchiMcpConfigResult {
	const cwd = options.cwd ?? process.cwd()
	if (options.includeProjectSources === false) {
		// The upstream loader does not expose a source filter. Resolve its complete
		// user-level behavior against a cwd outside the repository so standard
		// project files, project host imports, and project package declarations
		// cannot enter the effective config. The resulting config must be passed to
		// createMcpAdapter() programmatically; otherwise it would rediscover the real
		// session cwd during initialization.
		const userConfigCwd = join(getAgentDir(), ".kimchi-mcp-user-config")
		return {
			config: loadUpstreamMcpConfig(undefined, userConfigCwd),
			useProgrammaticConfig: true,
			warnings: [],
		}
	}
	// piConfig.mcpProjectConfigDir makes the legacy .kimchi layer upstream's
	// normal project source, including its management UI and persistence paths.
	const configPath = options.overridePath
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
