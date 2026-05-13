import { createHash } from "node:crypto"
// metadata-cache.ts - Persistent MCP metadata cache
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge"
import { logger } from "./logger.js"
import { resourceNameToToolName } from "./resource-tools.js"
import type { McpResource, McpTool, ServerEntry, ToolMetadata } from "./types.js"
import { formatToolName, isToolExcluded } from "./types.js"
import { extractToolUiStreamMode, getAgentDir } from "./utils.js"

const CACHE_VERSION = 1
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
let _cachePath: string | undefined
function getCachePath(): string {
	return (_cachePath ??= join(getAgentDir(), "mcp-cache.json"))
}

export interface CachedTool {
	name: string
	description?: string
	inputSchema?: unknown
	uiResourceUri?: string
	uiStreamMode?: "eager" | "stream-first"
}

export interface CachedResource {
	uri: string
	name: string
	description?: string
}

export interface ServerCacheEntry {
	configHash: string
	tools: CachedTool[]
	resources: CachedResource[]
	cachedAt: number
}

export interface MetadataCache {
	version: number
	servers: Record<string, ServerCacheEntry>
}

export function getMetadataCachePath(): string {
	return getCachePath()
}

/**
 * Type guard to validate cache structure.
 */
function isValidCache(cache: unknown): cache is MetadataCache {
	return !!(
		cache &&
		typeof cache === "object" &&
		"version" in cache &&
		cache.version === CACHE_VERSION &&
		"servers" in cache &&
		cache.servers &&
		typeof cache.servers === "object"
	)
}

/**
 * Safely load existing cache from disk, returning empty cache on any error.
 */
function loadExistingCache(): MetadataCache {
	const cache: MetadataCache = { version: CACHE_VERSION, servers: {} }

	if (!existsSync(getCachePath())) return cache

	try {
		const existing = JSON.parse(readFileSync(getCachePath(), "utf-8"))
		if (isValidCache(existing)) {
			cache.servers = { ...existing.servers }
		}
	} catch {
		// Ignore parse errors and return empty cache
	}

	return cache
}

/**
 * Atomically write cache data to disk using temp file + rename.
 */
function atomicWriteCache(data: MetadataCache): void {
	const cachePath = getCachePath()
	const tmpPath = `${cachePath}.${process.pid}.tmp`

	mkdirSync(dirname(cachePath), { recursive: true })
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
	renameSync(tmpPath, cachePath)
}

/**
 * Best-effort cleanup of temporary file. Swallows all errors.
 */
function cleanupTempFile(tmpPath: string): void {
	try {
		if (existsSync(tmpPath)) unlinkSync(tmpPath)
	} catch {
		// nothing to do — the next run will overwrite or ignore stale temp files
	}
}

export function loadMetadataCache(): MetadataCache | null {
	if (!existsSync(getCachePath())) return null
	try {
		const raw = JSON.parse(readFileSync(getCachePath(), "utf-8"))
		if (!isValidCache(raw)) return null
		return raw
	} catch {
		return null
	}
}

export function saveMetadataCache(cache: MetadataCache): void {
	const merged = loadExistingCache()
	merged.servers = { ...merged.servers, ...cache.servers }
	atomicWriteCache(merged)
}

/**
 * Replace the on-disk cache with the provided content (no merge with existing).
 * Use only when you need to delete entries; for adds/updates prefer
 * `saveMetadataCache` so concurrent writers don't clobber each other.
 *
 * I/O failures (read-only filesystem, full disk, permission denied) are logged
 * and swallowed — the cache is a derived artifact and must never crash the
 * extension host during startup. Callers that need to know the write succeeded
 * should re-read with `loadMetadataCache()`.
 */
export function overwriteMetadataCache(cache: MetadataCache): void {
	const cachePath = getCachePath()
	const tmpPath = `${cachePath}.${process.pid}.tmp`
	const out: MetadataCache = { version: CACHE_VERSION, servers: cache.servers ?? {} }

	try {
		atomicWriteCache(out)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		logger.debug(`MCP: failed to overwrite metadata cache at ${cachePath}: ${message}`)
		// Best-effort cleanup of a half-written temp file so we don't accumulate
		// `.pid.tmp` dotfiles on repeated failures. If this throws too, drop it.
		cleanupTempFile(tmpPath)
	}
}

/**
 * Drop cache entries whose configHash no longer matches the current server
 * definition. Orphan entries (cached servers not in the current config) are
 * kept by default because the cache file is shared across projects — a server
 * absent from this project's `mcp.json` is likely configured by another.
 *
 * Returns the cleaned cache and the list of removed server names. Caller is
 * responsible for persisting via `overwriteMetadataCache` when
 * `removed.length > 0`.
 */
export function purgeStaleEntries(
	cache: MetadataCache | null,
	mcpServers: Record<string, ServerEntry>,
): { cleaned: MetadataCache; removed: string[] } {
	const cleaned: MetadataCache = { version: CACHE_VERSION, servers: {} }
	const removed: string[] = []
	if (!cache?.servers) return { cleaned, removed }

	for (const [name, entry] of Object.entries(cache.servers)) {
		const definition = mcpServers[name]
		if (!definition) {
			// Orphan from another project's config — preserve.
			cleaned.servers[name] = entry
			continue
		}
		if (!entry?.configHash || entry.configHash !== computeServerHash(definition)) {
			removed.push(name)
			continue
		}
		cleaned.servers[name] = entry
	}

	return { cleaned, removed }
}

export function computeServerHash(definition: ServerEntry): string {
	// Hash only fields that affect server identity and tool/resource output.
	// Exclude lifecycle, idleTimeout, debug — those are runtime behavior settings
	// that don't change which tools a server exposes.
	const identity: Record<string, unknown> = {
		command: definition.command,
		args: definition.args,
		env: definition.env,
		cwd: definition.cwd,
		url: definition.url,
		headers: definition.headers,
		auth: definition.auth,
		bearerToken: definition.bearerToken,
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		excludeTools: definition.excludeTools,
	}
	const normalized = stableStringify(identity)
	return createHash("sha256").update(normalized).digest("hex")
}

export function isServerCacheValid(
	entry: ServerCacheEntry,
	definition: ServerEntry,
	maxAgeMs: number = CACHE_MAX_AGE_MS,
): boolean {
	if (!entry || entry.configHash !== computeServerHash(definition)) return false
	if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false
	if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false
	return true
}

/**
 * Build tool metadata if not excluded, otherwise return null.
 */
function buildToolMetadata(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	excludeTools: ServerEntry["excludeTools"],
	additionalFields: Partial<ToolMetadata>,
): ToolMetadata | null {
	if (isToolExcluded(toolName, serverName, prefix, excludeTools)) {
		return null
	}

	return {
		name: formatToolName(toolName, serverName, prefix),
		originalName: toolName,
		description: "",
		...additionalFields,
	}
}

export function reconstructToolMetadata(
	serverName: string,
	entry: ServerCacheEntry,
	prefix: "server" | "none" | "short",
	definition: Pick<ServerEntry, "exposeResources" | "excludeTools">,
): ToolMetadata[] {
	const metadata: ToolMetadata[] = []

	for (const tool of entry.tools ?? []) {
		if (!tool?.name) continue

		const toolMetadata = buildToolMetadata(tool.name, serverName, prefix, definition.excludeTools, {
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			uiResourceUri: tool.uiResourceUri,
			uiStreamMode: tool.uiStreamMode,
		})

		if (toolMetadata) {
			metadata.push(toolMetadata)
		}
	}

	if (definition.exposeResources !== false) {
		for (const resource of entry.resources ?? []) {
			if (!resource?.name || !resource?.uri) continue

			const baseName = `get_${resourceNameToToolName(resource.name)}`
			const resourceMetadata = buildToolMetadata(
				baseName,
				serverName,
				prefix,
				definition.excludeTools,
				{
					description: resource.description ?? `Read resource: ${resource.uri}`,
					resourceUri: resource.uri,
				},
			)

			if (resourceMetadata) {
				metadata.push(resourceMetadata)
			}
		}
	}

	return metadata
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
	return tools
		.filter((t) => t?.name)
		.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
			uiResourceUri: tryGetToolUiResourceUri(t),
			uiStreamMode: extractToolUiStreamMode(t._meta),
		}))
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
	return resources
		.filter((r) => r?.name && r?.uri)
		.map((r) => ({
			uri: r.uri,
			name: r.name,
			description: r.description,
		}))
}

function stableStringify(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		const serialized = JSON.stringify(value)
		return serialized === undefined ? "undefined" : serialized
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`
	}
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj).sort()
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

function tryGetToolUiResourceUri(tool: McpTool): string | undefined {
	try {
		return getToolUiResourceUri({ _meta: tool._meta })
	} catch {
		return undefined
	}
}
