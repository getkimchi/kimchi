import { computeServerHash, saveMetadataCache } from "pi-mcp-adapter/metadata-cache"
import type { McpConfig, ServerCacheEntry } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"
import { decideAutoMcpCall } from "./auto-policy.js"
import type { CacheFileStamp } from "./cache-file-stamp.js"
import type { snapshotMcpCallCatalog } from "./call-catalog.js"
import { McpCallCatalogStore } from "./call-catalog-store.js"
import { describeMcpCall, type McpCallCatalog } from "./call-facts.js"

const baseStamp: CacheFileStamp = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n }
const config: McpConfig = { mcpServers: { docs: { url: "https://docs.example/mcp" } } }

function setup(options: { expiresAt?: number } = {}) {
	const registeredToolNames = new Set<string>(["mcp"])
	const state = { stamp: baseStamp as CacheFileStamp | null, now: 0, envKey: "A=1" }
	const snapshot = vi.fn<typeof snapshotMcpCallCatalog>(
		(cfg, _privateCatalogs, names): McpCallCatalog => ({
			config: cfg,
			candidates: [],
			registeredToolNames: names,
			staleServers: new Set(),
			expiresAt: options.expiresAt ?? Number.POSITIVE_INFINITY,
		}),
	)
	const store = new McpCallCatalogStore(config, registeredToolNames, {
		statCacheFile: () => state.stamp,
		now: () => state.now,
		envKey: () => state.envKey,
		snapshot,
	})
	return { store, snapshot, state, registeredToolNames }
}

const entry: ServerCacheEntry = {
	configHash: "hash",
	cachedAt: 0,
	cacheScope: "private",
	resources: [],
	tools: [],
}

describe("McpCallCatalogStore", () => {
	it("reuses the catalog while the freshness key is unchanged", () => {
		const { store, snapshot } = setup()
		const first = store.catalog()
		expect(store.catalog()).toBe(first)
		expect(store.catalog()).toBe(first)
		expect(snapshot).toHaveBeenCalledTimes(1)
	})

	it("rebuilds when the cache file stamp changes", () => {
		for (const field of Object.keys(baseStamp) as (keyof CacheFileStamp)[]) {
			const { store, snapshot, state } = setup()
			store.catalog()
			state.stamp = { ...baseStamp, [field]: baseStamp[field] + 1n }
			store.catalog()
			expect(snapshot, field).toHaveBeenCalledTimes(2)
			store.catalog()
			expect(snapshot, field).toHaveBeenCalledTimes(2)
		}
	})

	it("rebuilds when the process environment changes", () => {
		const { store, snapshot, state } = setup()
		store.catalog()
		state.envKey = "A=2"
		store.catalog()
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(2)
	})

	it("sees an env var change that makes a cached server stale", () => {
		vi.stubEnv("TEST_MCP_DOCS_URL", "https://docs.example/mcp")
		try {
			const envConfig: McpConfig = { mcpServers: { docs: { url: "${TEST_MCP_DOCS_URL}" } } }
			const docs = envConfig.mcpServers.docs
			if (docs === undefined) throw new Error("missing docs server")
			saveMetadataCache({
				version: 1,
				servers: {
					docs: {
						configHash: computeServerHash(docs),
						cachedAt: Date.now(),
						resources: [],
						tools: [{ name: "get_issue", annotations: { readOnlyHint: true } }],
					},
				},
			})
			const store = new McpCallCatalogStore(envConfig, new Set(["mcp"]))
			expect(store.catalog().staleServers).toEqual(new Set())

			vi.stubEnv("TEST_MCP_DOCS_URL", "https://other.example/mcp")
			expect(store.catalog().staleServers).toEqual(new Set(["docs"]))
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it("rebuilds after setConfig, setPrivateCatalog, deletePrivateCatalog and resetPrivateCatalogs", () => {
		const { store, snapshot } = setup()
		const mutations = [
			() => store.setConfig({ mcpServers: {} }),
			() => store.setPrivateCatalog("docs", entry),
			() => store.deletePrivateCatalog("docs"),
			() => store.resetPrivateCatalogs(),
		]
		store.catalog()
		let calls = 1
		for (const mutate of mutations) {
			mutate()
			store.catalog()
			calls += 1
			expect(snapshot).toHaveBeenCalledTimes(calls)
		}
	})

	it("rebuilds once now reaches expiresAt", () => {
		const { store, snapshot, state } = setup({ expiresAt: 1000 })
		state.now = 999
		store.catalog()
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(1)
		state.now = 1000
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(2)
	})

	it("never reuses a catalog when the stamp is unknown", () => {
		const { store, snapshot, state } = setup()
		state.stamp = null
		store.catalog()
		store.catalog()
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(3)
		state.stamp = baseStamp
		store.catalog()
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(4)
	})

	it("takes the stamp before building", () => {
		const { store, snapshot, state } = setup()
		snapshot.mockImplementationOnce((cfg, _privateCatalogs, names) => {
			state.stamp = { ...baseStamp, mtimeNs: 99n }
			return { config: cfg, candidates: [], registeredToolNames: names, staleServers: new Set(), expiresAt: Infinity }
		})
		store.catalog()
		store.catalog()
		expect(snapshot).toHaveBeenCalledTimes(2)
	})

	it("does not keep a key when the snapshot throws", () => {
		const { store, snapshot } = setup()
		snapshot.mockImplementationOnce(() => {
			throw new Error("boom")
		})
		expect(() => store.catalog()).toThrow("boom")
		expect(store.catalog().candidates).toEqual([])
		expect(snapshot).toHaveBeenCalledTimes(2)
	})

	it("passes its own private catalogs and registered names to snapshot", () => {
		const { store, snapshot, registeredToolNames } = setup()
		store.setPrivateCatalog("docs", entry)
		store.catalog()
		const [passedConfig, passedPrivate, passedNames] = snapshot.mock.calls[0] ?? []
		expect(passedConfig).toBe(config)
		expect(passedPrivate).toEqual(new Map([["docs", entry]]))
		expect(passedNames).toBe(registeredToolNames)
	})

	it("sees an annotation change written by the adapter to the real cache file", () => {
		const docs = config.mcpServers.docs
		if (docs === undefined) throw new Error("missing docs server")
		const writeCache = (readOnlyHint: boolean) =>
			saveMetadataCache({
				version: 1,
				servers: {
					docs: {
						configHash: computeServerHash(docs),
						cachedAt: Date.now(),
						resources: [],
						tools: [{ name: "get_issue", annotations: { readOnlyHint } }],
					},
				},
			})
		const decide = (store: McpCallCatalogStore) =>
			decideAutoMcpCall(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, store.catalog()))
		const store = new McpCallCatalogStore(config, new Set(["mcp"]))

		writeCache(true)
		expect(decide(store)).toEqual({ action: "allow", sourceDetail: "mcp_readonly_annotation" })
		expect(decide(store)).toEqual({ action: "allow", sourceDetail: "mcp_readonly_annotation" })

		writeCache(false)
		expect(decide(store)).toEqual({ action: "classify" })
	})
})
