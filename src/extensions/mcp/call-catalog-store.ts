import type { McpConfig, ServerCacheEntry } from "pi-mcp-adapter/types"
import { type CacheFileStamp, sameCacheFileStamp, statMetadataCacheFile } from "./cache-file-stamp.js"
import { snapshotMcpCallCatalog } from "./call-catalog.js"
import type { McpCallCatalog } from "./call-facts.js"

export interface McpCallCatalogStoreDeps {
	statCacheFile(): CacheFileStamp | null
	now(): number
	envKey(): string
	snapshot: typeof snapshotMcpCallCatalog
}

interface CachedCatalog {
	catalog: McpCallCatalog
	version: number
	stamp: CacheFileStamp
	envKey: string
}

/** Server hashes interpolate env vars, so an env change can turn a cache entry stale. */
function processEnvKey(): string {
	let key = ""
	for (const name in process.env) key += `${name}\0${process.env[name]}\0`
	return key
}

/**
 * Reuses the last MCP call catalog until its freshness key changes: the config,
 * the private catalogs (one `version` counter), the cache file stat, the
 * process environment, or a TTL expiry. When freshness cannot be proven (unknown stamp, failed build) it
 * rebuilds; nothing is keyed on an unknown stamp or on a build that threw.
 */
export class McpCallCatalogStore {
	private readonly privateCatalogs = new Map<string, ServerCacheEntry>()
	private readonly deps: McpCallCatalogStoreDeps
	private version = 0
	private cached: CachedCatalog | undefined

	/**
	 * `registeredToolNames` is a live set the caller keeps mutating. It is passed to
	 * every snapshot by reference, never copied, and is not part of the freshness key.
	 */
	constructor(
		private config: McpConfig,
		private readonly registeredToolNames: ReadonlySet<string>,
		deps: Partial<McpCallCatalogStoreDeps> = {},
	) {
		this.deps = {
			statCacheFile: statMetadataCacheFile,
			now: Date.now,
			envKey: processEnvKey,
			snapshot: snapshotMcpCallCatalog,
			...deps,
		}
	}

	setConfig(config: McpConfig): void {
		this.config = config
		this.version += 1
	}

	setPrivateCatalog(serverName: string, entry: ServerCacheEntry): void {
		this.privateCatalogs.set(serverName, entry)
		this.version += 1
	}

	deletePrivateCatalog(serverName: string): void {
		this.privateCatalogs.delete(serverName)
		this.version += 1
	}

	resetPrivateCatalogs(): void {
		this.privateCatalogs.clear()
		this.version += 1
	}

	catalog(): McpCallCatalog {
		// Stat before building: a rewrite during the build leaves a newer stamp, so the next call rebuilds.
		const stamp = this.deps.statCacheFile()
		const envKey = this.deps.envKey()
		const cached = this.cached
		if (
			stamp !== null &&
			cached !== undefined &&
			cached.version === this.version &&
			sameCacheFileStamp(cached.stamp, stamp) &&
			cached.envKey === envKey &&
			this.deps.now() < cached.catalog.expiresAt
		) {
			return cached.catalog
		}
		this.cached = undefined
		const version = this.version
		const catalog = this.deps.snapshot(this.config, this.privateCatalogs, this.registeredToolNames)
		if (stamp !== null) this.cached = { catalog, version, stamp, envKey }
		return catalog
	}
}
