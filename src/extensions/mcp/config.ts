import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadMcpConfig as loadUpstreamMcpConfig } from "pi-mcp-adapter/config"
import type { McpConfig } from "pi-mcp-adapter/types"

export const LEGACY_PROJECT_MCP_CONFIG = ".kimchi/mcp.json"

export interface KimchiMcpConfigResult {
	config: McpConfig
	configPath?: string
	warnings: string[]
}

/**
 * Keep the adapter in its file-backed mode so its panels and persistence stay
 * available. Kimchi's legacy project file becomes the highest-precedence
 * configPath; upstream still merges every standard MCP source beneath it.
 */
export function loadKimchiMcpConfig(options: { cwd?: string; overridePath?: string } = {}): KimchiMcpConfigResult {
	const cwd = options.cwd ?? process.cwd()
	const exclusiveMode = process.env.PI_MCP_CONFIG_MODE?.trim().toLowerCase() === "exclusive"
	const legacyPath = resolve(cwd, LEGACY_PROJECT_MCP_CONFIG)
	const configPath = options.overridePath ?? (!exclusiveMode && existsSync(legacyPath) ? legacyPath : undefined)

	return {
		config: loadUpstreamMcpConfig(configPath, cwd),
		...(configPath ? { configPath } : {}),
		warnings: [],
	}
}
