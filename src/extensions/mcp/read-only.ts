/**
 * Read-only qualification for MCP tools.
 *
 * Planning mode admits read-only MCP direct tools and uses this same
 * qualification for nested gateway calls. The gateway itself receives separate
 * argument-aware authorization in index.ts; script and namespace proxies stay
 * blocked. Direct-tool classification follows the MCP spec first and a name
 * convention second:
 *
 * - `annotations.readOnlyHint === true` qualifies the tool, always.
 * - When the server publishes NO annotations at all, a name-prefix convention
 *   (`get_`, `search_`, `list_`, `read_`, `fetch_`) is used as a best-effort
 *   signal, with a one-time warning per tool so operators can audit it.
 * - When any annotations are present without an explicit `readOnlyHint: true`,
 *   the convention never applies — the explicit annotation wins.
 *
 * Annotations reach Kimchi through the adapter's persistent shared metadata
 * cache plus its current session's private catalogs. Private entries never
 * cross sessions or become persistent shared cache entries. Wire names are
 * computed exactly as the adapter registers them, from the same config.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import {
	computeServerHash,
	isServerCacheValid,
	loadMetadataCache,
	reconstructToolMetadata,
} from "pi-mcp-adapter/metadata-cache"
import {
	formatServerNamespace,
	formatToolName,
	getServerPrefix,
	getToolNameCandidates,
	isServerDisabled,
	type McpConfig,
	resolveToolPrefix,
	type ServerCacheEntry,
	type ToolMetadata,
	type ToolPrefix,
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

interface McpToolCandidate {
	serverName: string
	prefix: ToolPrefix
	tool: ToolMetadata
	readOnly: boolean
}

function collectMcpToolCandidates(
	config: McpConfig,
	privateCatalogs?: ReadonlyMap<string, ServerCacheEntry>,
): McpToolCandidate[] {
	const cache = loadMetadataCache()
	if (!cache?.servers && !privateCatalogs?.size) return []
	const candidates: McpToolCandidate[] = []
	const reserved = new Set([
		"mcp",
		"mcpScript",
		...Object.keys(config.mcpServers).map((name) => `mcp__${formatServerNamespace(name)}`),
	])
	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		if (isServerDisabled(definition)) continue
		const sessionEntry = privateCatalogs?.get(serverName)
		if (
			sessionEntry &&
			(sessionEntry.cacheScope !== "private" || sessionEntry.configHash !== computeServerHash(definition))
		)
			continue
		// Match the adapter's own in-memory direct-tool projection: session-only
		// cache hints are not revalidated against the persistent cache contract.
		let entry = cache?.servers[serverName]
		if (sessionEntry !== undefined) {
			const { ttlMs: _sessionTtl, cacheScope: _sessionScope, ...sessionCatalog } = sessionEntry
			entry = { ...sessionCatalog, cachedAt: Date.now() }
		}
		if (!entry || (!sessionEntry && !isServerCacheValid(entry, definition))) continue
		const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix)
		const nameCounts = new Map<string, number>()
		for (const tool of entry.tools) {
			const name = formatToolName(tool.name, serverName, prefix)
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
		}
		for (const tool of reconstructToolMetadata(
			serverName,
			entry,
			prefix,
			definition,
			config.mcpServers,
			cache ?? undefined,
		)) {
			if (reserved.has(tool.name)) continue
			const source = entry.tools.find((candidate) => candidate.name === tool.originalName)
			const sourceResource =
				tool.resourceUri === undefined
					? undefined
					: entry.resources.find((resource) => resource.uri === tool.resourceUri)
			candidates.push({
				serverName,
				prefix,
				tool,
				readOnly:
					sourceResource !== undefined ||
					(nameCounts.get(tool.name) === 1 &&
						tool.resourceUri === undefined &&
						source !== undefined &&
						isReadOnlyQualifiedMcpTool(source.name, source.annotations)),
			})
		}
	}
	return candidates
}

/**
 * Compute the wire names of read-only-qualified direct tools from the
 * adapter's valid metadata, using upstream filtering and wire-name rules.
 * Ambiguous names fail closed: a read-only claim must never authorize a
 * different server's tool. The facade intersects these candidates with its
 * registered tools before exposing them to the planning profile. With
 * `server`, only that server's tools qualify, as for a gateway call naming it.
 */
export function collectReadOnlyMcpWireNames(
	config: McpConfig,
	server?: string,
	privateCatalogs?: ReadonlyMap<string, ServerCacheEntry>,
): string[] {
	const qualified = new Map<string, boolean>()
	for (const { serverName, tool, readOnly } of collectMcpToolCandidates(config, privateCatalogs)) {
		qualified.set(tool.name, (server === undefined || serverName === server) && !qualified.has(tool.name) && readOnly)
	}
	return [...qualified].filter(([, readOnly]) => readOnly).map(([name]) => name)
}

function hasSingleReadOnlyMatch(candidates: McpToolCandidate[]): boolean {
	return candidates.length === 1 && candidates[0]?.readOnly === true
}

function resolveServerGatewayTool(candidates: McpToolCandidate[], toolName: string, serverName: string): boolean {
	const scoped = candidates.filter((candidate) => candidate.serverName === serverName)
	const exact = scoped.filter((candidate) => candidate.tool.name === toolName)
	if (exact.length > 0) return hasSingleReadOnlyMatch(exact)
	return hasSingleReadOnlyMatch(
		scoped.filter((candidate) =>
			getToolNameCandidates(candidate.tool.originalName, serverName, candidate.prefix).has(toolName),
		),
	)
}

function prefixedServerScope(config: McpConfig, toolName: string): string | undefined {
	const candidates = Object.entries(config.mcpServers)
		.filter(([, definition]) => !isServerDisabled(definition))
		.map(([serverName, definition]) => ({
			serverName,
			prefix: getServerPrefix(serverName, resolveToolPrefix(definition, config.settings?.toolPrefix)),
		}))
		.filter(({ prefix }) => prefix.length > 0 && toolName.startsWith(`${prefix}_`))
		.sort((a, b) => b.prefix.length - a.prefix.length)
	if (candidates.length === 0) return undefined
	const longest = candidates[0]?.prefix.length
	const best = candidates.filter(({ prefix }) => prefix.length === longest)
	return best.length === 1 ? best[0]?.serverName : undefined
}

/**
 * Whether a gateway tool argument resolves to one read-only tool using the
 * adapter's displayed/original/legacy name semantics. Exact displayed names
 * win over original names, followed by prefixed-server and candidate aliases;
 * every ambiguity, stale metadata entry, and cross-server collision fails closed.
 */
export function isReadOnlyQualifiedMcpGatewayTool(
	config: McpConfig,
	toolName: string,
	server?: string,
	privateCatalogs?: ReadonlyMap<string, ServerCacheEntry>,
): boolean {
	const candidates = collectMcpToolCandidates(config, privateCatalogs)
	if (server !== undefined) return resolveServerGatewayTool(candidates, toolName, server)

	const exact = candidates.filter((candidate) => candidate.tool.name === toolName)
	if (exact.length > 0) return hasSingleReadOnlyMatch(exact)
	const original = candidates.filter((candidate) => candidate.tool.originalName === toolName)
	if (original.length > 0) return hasSingleReadOnlyMatch(original)

	const scopedServer = prefixedServerScope(config, toolName)
	if (scopedServer !== undefined) return resolveServerGatewayTool(candidates, toolName, scopedServer)
	return hasSingleReadOnlyMatch(
		candidates.filter((candidate) =>
			getToolNameCandidates(candidate.tool.originalName, candidate.serverName, candidate.prefix).has(toolName),
		),
	)
}
