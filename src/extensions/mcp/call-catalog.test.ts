import { computeServerHash } from "pi-mcp-adapter/metadata-cache"
import type { McpConfig, MetadataCache, ServerCacheEntry } from "pi-mcp-adapter/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { snapshotMcpCallCatalog } from "./call-catalog.js"
import { describeMcpCall } from "./call-facts.js"

const cacheState = vi.hoisted(() => ({ cache: undefined as MetadataCache | undefined }))

vi.mock("pi-mcp-adapter/metadata-cache", async (importOriginal) => ({
	...(await importOriginal<typeof import("pi-mcp-adapter/metadata-cache")>()),
	loadMetadataCache: () => cacheState.cache,
}))

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
