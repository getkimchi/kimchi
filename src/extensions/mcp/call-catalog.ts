import { isServerCacheValid, loadMetadataCache } from "pi-mcp-adapter/metadata-cache"
import { isServerDisabled, type McpConfig, type ServerCacheEntry } from "pi-mcp-adapter/types"
import { type McpCallCatalog, resolveMcpGatewayTool } from "./call-facts.js"
import { collectMcpToolCandidates, isPrivateEntryUsable, isReadOnlyEvidence } from "./read-only.js"

export function snapshotMcpCallCatalog(
	config: McpConfig,
	privateCatalogs: ReadonlyMap<string, ServerCacheEntry>,
	registeredToolNames: ReadonlySet<string>,
): McpCallCatalog {
	const cache = loadMetadataCache()
	const staleServers = new Set<string>()
	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		if (isServerDisabled(definition)) continue
		const privateEntry = privateCatalogs.get(serverName)
		if (privateEntry !== undefined) {
			if (!isPrivateEntryUsable(privateEntry, definition)) staleServers.add(serverName)
			continue
		}
		const persistentEntry = cache?.servers[serverName]
		if (persistentEntry !== undefined && !isServerCacheValid(persistentEntry, definition)) {
			staleServers.add(serverName)
		}
	}
	return {
		config,
		candidates: collectMcpToolCandidates(config, cache, privateCatalogs),
		registeredToolNames,
		staleServers,
	}
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
	const facts = resolveMcpGatewayTool(
		{ tool: toolName, server },
		snapshotMcpCallCatalog(config, privateCatalogs ?? new Map(), new Set()),
	)
	return facts.kind === "tool" && isReadOnlyEvidence(facts.evidence)
}
