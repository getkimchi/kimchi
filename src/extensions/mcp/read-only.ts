/**
 * Read-only qualification for MCP tools.
 *
 * Planning mode admits read-only MCP direct tools and blocks everything else
 * (gateway, script, namespace proxies, and non-read-only direct tools). The
 * classification follows the MCP spec first and a name convention second:
 *
 * - `annotations.readOnlyHint === true` qualifies the tool, always.
 * - When the server publishes NO annotations at all, a name-prefix convention
 *   (`get_`, `search_`, `list_`, `read_`, `fetch_`) is used as a best-effort
 *   signal, with a one-time warning per tool so operators can audit it.
 * - When any annotations are present without an explicit `readOnlyHint: true`,
 *   the convention never applies — the explicit annotation wins.
 *
 * Annotations reach Kimchi through the adapter's persistent metadata cache
 * (the dependency patch retains them when serializing live tools). Wire names
 * are computed exactly as the adapter registers them, from the same config.
 */

import { loadMetadataCache } from "pi-mcp-adapter/metadata-cache"
import { type McpConfig, type ToolPrefix, formatToolName, resolveToolPrefix } from "pi-mcp-adapter/types"

type ToolAnnotations = { readOnlyHint?: boolean }

const READ_ONLY_NAME_PREFIXES = /^(get|search|list|read|fetch)/

/** Process-level dedupe for convention promotions — audit signal, not noise. */
const warnedConventionPromotions = new Set<string>()

export function isReadOnlyQualifiedMcpTool(originalName: string, annotations?: ToolAnnotations | null): boolean {
	if (annotations?.readOnlyHint === true) return true
	if (annotations === undefined || annotations === null) {
		if (READ_ONLY_NAME_PREFIXES.test(originalName)) {
			if (!warnedConventionPromotions.has(originalName)) {
				warnedConventionPromotions.add(originalName)
				console.warn(`[mcp] Tool "${originalName}" promoted to read-only via name convention (no annotations)`)
			}
			return true
		}
	}
	return false
}

/**
 * Compute the wire names of read-only-qualified direct tools from the
 * adapter's metadata cache, restricted to servers present in the config so
 * unconfigured cache leftovers never leak into a planning snapshot.
 */
export function collectReadOnlyMcpWireNames(config: McpConfig): string[] {
	const cache = loadMetadataCache()
	if (!cache?.servers) return []
	const names = new Set<string>()
	for (const [serverName, entry] of Object.entries(cache.servers)) {
		const definition = config.mcpServers[serverName]
		if (!definition) continue
		const prefix: ToolPrefix = resolveToolPrefix(definition, config.settings?.toolPrefix)
		for (const tool of entry.tools ?? []) {
			if (isReadOnlyQualifiedMcpTool(tool.name, tool.annotations)) {
				names.add(formatToolName(tool.name, serverName, prefix))
			}
		}
	}
	return [...names]
}
