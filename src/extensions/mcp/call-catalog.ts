import { computeServerHash, isServerCacheValid, loadMetadataCache } from "pi-mcp-adapter/metadata-cache"
import { isServerDisabled, type McpConfig, type ServerCacheEntry, type ServerEntry } from "pi-mcp-adapter/types"
import type { McpCallCatalog } from "./call-facts.js"
import { collectMcpToolCandidates } from "./read-only.js"

function isPrivateEntryUsable(entry: ServerCacheEntry, definition: ServerEntry): boolean {
	return entry.cacheScope === "private" && entry.configHash === computeServerHash(definition)
}

export function snapshotMcpCallCatalog(
	config: McpConfig,
	privateCatalogs: ReadonlyMap<string, ServerCacheEntry>,
	registeredToolNames: ReadonlySet<string>,
): McpCallCatalog {
	const cache = loadMetadataCache()
	const staleServers = new Set<string>()
	const disabledServers = new Set<string>()
	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		if (isServerDisabled(definition)) {
			disabledServers.add(serverName)
			continue
		}
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
		candidates: collectMcpToolCandidates(config, privateCatalogs),
		registeredToolNames: new Set(registeredToolNames),
		staleServers,
		disabledServers,
	}
}
