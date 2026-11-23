import { computeServerHash } from "pi-mcp-adapter/metadata-cache"
import type { CachedTool, McpConfig, MetadataCache, ServerCacheEntry } from "pi-mcp-adapter/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isReadOnlyQualifiedMcpGatewayTool, snapshotMcpCallCatalog } from "./call-catalog.js"
import { describeMcpCall } from "./call-facts.js"
import { collectReadOnlyMcpWireNames } from "./read-only.js"

const cacheState = vi.hoisted(() => ({
	cache: undefined as MetadataCache | undefined,
	loadMetadataCache: vi.fn<() => MetadataCache | undefined>(),
}))
const hashState = vi.hoisted(() => ({ throwFor: undefined as string | undefined }))

vi.mock("pi-mcp-adapter/metadata-cache", async (importOriginal) => {
	const original = await importOriginal<typeof import("pi-mcp-adapter/metadata-cache")>()
	return {
		...original,
		computeServerHash: (definition: Parameters<typeof original.computeServerHash>[0]) => {
			if (hashState.throwFor !== undefined && definition.command === hashState.throwFor) {
				throw new Error(`Cannot hash ${definition.command}`)
			}
			return original.computeServerHash(definition)
		},
		loadMetadataCache: cacheState.loadMetadataCache,
	}
})

function privateEntry(config: McpConfig, server: string, readOnlyHint: boolean): ServerCacheEntry {
	return {
		configHash: computeServerHash(config.mcpServers[server]),
		cachedAt: Date.now(),
		cacheScope: "private",
		resources: [],
		tools: [{ name: "get_issue", annotations: { readOnlyHint } }],
	}
}

function persistentEntry(config: McpConfig, server: string): ServerCacheEntry {
	return {
		configHash: computeServerHash(config.mcpServers[server]),
		cachedAt: Date.now(),
		resources: [],
		tools: [{ name: "get_issue", annotations: { readOnlyHint: true } }],
	}
}

describe("snapshotMcpCallCatalog", () => {
	beforeEach(() => {
		cacheState.cache = { version: 1, servers: {} }
		cacheState.loadMetadataCache.mockReset().mockImplementation(() => cacheState.cache)
		hashState.throwFor = undefined
	})

	it("loads persistent metadata at most once per snapshot", () => {
		const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", directTools: true } } }
		cacheState.cache = { version: 1, servers: { docs: persistentEntry(config, "docs") } }

		snapshotMcpCallCatalog(config, new Map(), new Set(["mcp", "docs_get_issue"]))

		expect(cacheState.loadMetadataCache).toHaveBeenCalledTimes(1)
	})

	it("keeps private catalog candidates isolated between session snapshots", () => {
		const firstConfig: McpConfig = { mcpServers: { docs: { url: "https://first.example/mcp", directTools: true } } }
		const secondConfig: McpConfig = { mcpServers: { docs: { url: "https://second.example/mcp", directTools: true } } }
		const first = snapshotMcpCallCatalog(
			firstConfig,
			new Map([["docs", privateEntry(firstConfig, "docs", true)]]),
			new Set(["docs_get_issue"]),
		)
		const second = snapshotMcpCallCatalog(
			secondConfig,
			new Map([["docs", privateEntry(secondConfig, "docs", false)]]),
			new Set(["docs_get_issue"]),
		)

		expect(describeMcpCall("docs_get_issue", {}, first)).toMatchObject({ kind: "tool", evidence: "annotation_true" })
		expect(describeMcpCall("docs_get_issue", {}, second)).toMatchObject({ kind: "tool", evidence: "annotation_false" })
		expect(first.candidates).not.toBe(second.candidates)
		expect(first.registeredToolNames).not.toBe(second.registeredToolNames)
	})

	it("reports stale persistent and mismatched private metadata", () => {
		const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp", directTools: true } } }
		const expired = persistentEntry(config, "docs")
		expired.ttlMs = 1000
		expired.cachedAt = Date.now() - 2000
		cacheState.cache = { version: 1, servers: { docs: expired } }
		const persistent = snapshotMcpCallCatalog(config, new Map(), new Set(["docs_get_issue"]))
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, persistent)).toEqual({
			kind: "unresolved",
			via: "gateway",
			why: "stale",
		})

		const mismatched = { ...privateEntry(config, "docs", true), configHash: "another-config" }
		const privateSnapshot = snapshotMcpCallCatalog(config, new Map([["docs", mismatched]]), new Set(["docs_get_issue"]))
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, privateSnapshot)).toEqual({
			kind: "unresolved",
			via: "gateway",
			why: "stale",
		})
	})

	it("treats a server whose config hash throws as stale without failing other servers", () => {
		const config: McpConfig = {
			mcpServers: {
				broken: { command: "broken", directTools: true },
				docs: { command: "docs", directTools: true },
			},
		}
		const privateCatalogs = new Map([
			["broken", privateEntry(config, "broken", true)],
			["docs", privateEntry(config, "docs", true)],
		])
		hashState.throwFor = "broken"

		const catalog = snapshotMcpCallCatalog(config, privateCatalogs, new Set(["broken_get_issue", "docs_get_issue"]))

		expect(catalog.staleServers.has("broken")).toBe(true)
		expect(describeMcpCall("broken_get_issue", {}, catalog)).toMatchObject({ kind: "unresolved" })
		expect(describeMcpCall("docs_get_issue", {}, catalog)).toMatchObject({
			kind: "tool",
			server: "docs",
			evidence: "annotation_true",
		})
	})

	it("reports disabled configured servers", () => {
		const config: McpConfig = {
			mcpServers: { docs: { url: "https://docs.example/mcp", directTools: true, disabled: true } },
		}
		cacheState.cache = { version: 1, servers: { docs: persistentEntry(config, "docs") } }
		const snapshot = snapshotMcpCallCatalog(config, new Map(), new Set(["mcp", "mcp__docs"]))
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, snapshot)).toEqual({
			kind: "unresolved",
			via: "gateway",
			why: "disabled",
		})
		expect(snapshot.candidates).toEqual([])
	})
})

describe("isReadOnlyQualifiedMcpGatewayTool", () => {
	const config: McpConfig = {
		mcpServers: {
			alpha: { url: "https://a.example/mcp", directTools: true },
			beta: { url: "https://b.example/mcp", directTools: true, toolPrefix: "none" },
		},
	}
	function setCache(config: McpConfig, tools: Record<string, CachedTool[]>): MetadataCache {
		const cache: MetadataCache = { version: 1, servers: {} }
		for (const [name, definition] of Object.entries(config.mcpServers)) {
			cache.servers[name] = {
				configHash: computeServerHash(definition),
				cachedAt: Date.now(),
				resources: [],
				tools: tools[name] ?? [],
			}
		}
		cacheState.cache = cache
		return cache
	}

	beforeEach(() => {
		cacheState.loadMetadataCache.mockReset().mockImplementation(() => cacheState.cache)
		setCache(config, {
			alpha: [{ name: "get_issue" }, { name: "create_issue" }, { name: "stats", annotations: { readOnlyHint: true } }],
			beta: [{ name: "fetch_items" }],
		})
	})

	it("authorizes only the current session's matching private catalog", () => {
		cacheState.cache = { version: 1, servers: {} }
		const privateEntry = {
			configHash: computeServerHash(config.mcpServers.alpha),
			cachedAt: Date.now(),
			resources: [],
			tools: [{ name: "getJiraIssue", annotations: { readOnlyHint: true } }],
			cacheScope: "private" as const,
		}
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "getJiraIssue", "alpha")).toBe(false)
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "getJiraIssue", "alpha", new Map([["alpha", privateEntry]]))).toBe(
			true,
		)
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "alpha_getJiraIssue", "alpha", new Map())).toBe(false)
		const currentCatalog = new Map([["alpha", privateEntry]])
		expect(collectReadOnlyMcpWireNames(config, "alpha", currentCatalog)).toEqual(["alpha_getJiraIssue"])
		expect(
			isReadOnlyQualifiedMcpGatewayTool(
				config,
				"getJiraIssue",
				"alpha",
				new Map([["alpha", { ...privateEntry, configHash: "another-authorization-context" }]]),
			),
		).toBe(false)
	})

	it("accepts original names when they resolve to one read-only tool", () => {
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "get_issue", "alpha")).toBe(true)
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "get_issue")).toBe(true)
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "create_issue", "alpha")).toBe(false)
	})

	it("fails closed for ambiguous unscoped originals but allows server-scoped matches", () => {
		const collisionConfig = { ...config, settings: { toolPrefix: "none" as const } }
		setCache(collisionConfig, {
			alpha: [{ name: "get_access", annotations: { readOnlyHint: false } }],
			beta: [{ name: "get_access", annotations: { readOnlyHint: true } }],
		})
		expect(isReadOnlyQualifiedMcpGatewayTool(collisionConfig, "get_access")).toBe(false)
		expect(isReadOnlyQualifiedMcpGatewayTool(collisionConfig, "get_access", "alpha")).toBe(false)
		expect(isReadOnlyQualifiedMcpGatewayTool(collisionConfig, "get_access", "beta")).toBe(true)
	})

	it("qualifies cached resource-backed read tools", () => {
		const resourceConfig: McpConfig = { mcpServers: { alpha: { ...config.mcpServers.alpha } } }
		const cache = setCache(resourceConfig, { alpha: [] })
		cache.servers.alpha.resources = [{ name: "figjam", uri: "file:///board" }]

		expect(isReadOnlyQualifiedMcpGatewayTool(resourceConfig, "read_figjam", "alpha")).toBe(true)
		expect(isReadOnlyQualifiedMcpGatewayTool(resourceConfig, "alpha_read_figjam", "alpha")).toBe(true)
	})

	it("preserves displayed-name precedence when an original alias names another tool", () => {
		setCache(config, {
			alpha: [{ name: "get_issue", annotations: { readOnlyHint: true } }],
			beta: [{ name: "get_issue", annotations: { readOnlyHint: false } }],
		})
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "get_issue")).toBe(false)
		expect(isReadOnlyQualifiedMcpGatewayTool(config, "alpha_get_issue")).toBe(true)
	})

	it("rejects a tool name that two servers' prefixes match with equal length", () => {
		const config: McpConfig = {
			// Under "short", both names strip to the prefix "jira".
			mcpServers: {
				jira: { command: "jira", toolPrefix: "short" },
				"jira-mcp": { command: "jira-mcp", toolPrefix: "short" },
			},
		}
		cacheState.cache = {
			version: 1,
			servers: { jira: persistentEntry(config, "jira"), "jira-mcp": persistentEntry(config, "jira-mcp") },
		}

		expect(isReadOnlyQualifiedMcpGatewayTool(config, "jira_get_issue")).toBe(false)
	})
})
