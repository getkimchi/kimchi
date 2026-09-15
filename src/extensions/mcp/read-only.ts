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

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { isServerCacheValid, loadMetadataCache, reconstructToolMetadata } from "pi-mcp-adapter/metadata-cache"
import {
	formatServerNamespace,
	formatToolName,
	isServerDisabled,
	type McpConfig,
	resolveToolPrefix,
} from "pi-mcp-adapter/types"

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
 * adapter's valid metadata, using upstream filtering and wire-name rules.
 * Ambiguous names fail closed: a read-only claim must never authorize a
 * different server's tool. The facade intersects these candidates with its
 * registered tools before exposing them to the planning profile.
 */
export function collectReadOnlyMcpWireNames(config: McpConfig): string[] {
	const cache = loadMetadataCache()
	if (!cache?.servers) return []
	const qualified = new Map<string, boolean>()
	const reserved = new Set([
		"mcp",
		"mcpScript",
		...Object.keys(config.mcpServers).map((name) => `mcp__${formatServerNamespace(name)}`),
	])
	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const entry = cache.servers[serverName]
		if (isServerDisabled(definition) || !entry || !isServerCacheValid(entry, definition)) continue
		const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix)
		const nameCounts = new Map<string, number>()
		for (const tool of entry.tools) {
			const name = formatToolName(tool.name, serverName, prefix)
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
		}
		for (const tool of reconstructToolMetadata(serverName, entry, prefix, definition, config.mcpServers, cache)) {
			if (reserved.has(tool.name)) continue
			const source = entry.tools.find((candidate) => candidate.name === tool.originalName)
			qualified.set(
				tool.name,
				!qualified.has(tool.name) &&
					nameCounts.get(tool.name) === 1 &&
					!tool.resourceUri &&
					source !== undefined &&
					isReadOnlyQualifiedMcpTool(source.name, source.annotations),
			)
		}
	}
	return [...qualified].filter(([, readOnly]) => readOnly).map(([name]) => name)
}
