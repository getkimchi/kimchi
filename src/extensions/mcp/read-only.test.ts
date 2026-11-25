import { computeServerHash } from "pi-mcp-adapter/metadata-cache"
import type { CachedTool, McpConfig, MetadataCache } from "pi-mcp-adapter/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const cacheState = vi.hoisted(() => ({ cache: undefined as MetadataCache | undefined }))

vi.mock("pi-mcp-adapter/metadata-cache", async (importOriginal) => ({
	...(await importOriginal<typeof import("pi-mcp-adapter/metadata-cache")>()),
	loadMetadataCache: () => cacheState.cache,
}))

import {
	collectMcpToolCandidates,
	collectReadOnlyMcpWireNames,
	getMcpReadOnlyEvidence,
	isReadOnlyQualifiedMcpTool,
} from "./read-only.js"

describe("isReadOnlyQualifiedMcpTool", () => {
	it("qualifies any tool with an explicit readOnlyHint, regardless of name", () => {
		expect(isReadOnlyQualifiedMcpTool("deploy_stack", { readOnlyHint: true })).toBe(true)
	})

	it("rejects a convention-matching name when annotations veto it", () => {
		expect(isReadOnlyQualifiedMcpTool("get_full_write_access", { readOnlyHint: false })).toBe(false)
		expect(isReadOnlyQualifiedMcpTool("search_everything", { destructiveHint: false })).toBe(false)
	})

	it("applies the name convention only when the server publishes no annotations", () => {
		for (const name of ["get_issue", "search_docs", "list_repos", "read_file", "fetch_page"]) {
			expect(isReadOnlyQualifiedMcpTool(name, undefined)).toBe(true)
		}
		expect(isReadOnlyQualifiedMcpTool("write_file", undefined)).toBe(false)
		expect(isReadOnlyQualifiedMcpTool("create_pr", undefined)).toBe(false)
	})

	it("warns once per convention-promoted tool", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		isReadOnlyQualifiedMcpTool("get_once", undefined)
		isReadOnlyQualifiedMcpTool("get_once", undefined)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Tool "get_once" promoted to read-only via name convention'),
		)
		warn.mockRestore()
	})
})

describe("getMcpReadOnlyEvidence", () => {
	it("returns annotation_true when readOnlyHint is true", () => {
		expect(getMcpReadOnlyEvidence("deploy", { readOnlyHint: true })).toBe("annotation_true")
	})
	it("returns annotation_false when readOnlyHint is false", () => {
		expect(getMcpReadOnlyEvidence("get_item", { readOnlyHint: false })).toBe("annotation_false")
	})
	it("returns none when annotations omit readOnlyHint true", () => {
		expect(getMcpReadOnlyEvidence("get_item", { destructiveHint: true })).toBe("none")
	})
	it("returns unannotated for a non-convention name without annotations", () => {
		expect(getMcpReadOnlyEvidence("deploy", undefined)).toBe("unannotated")
	})
	it("returns name_convention for unannotated get search list read and fetch names", () => {
		for (const name of ["get_issue", "search_docs", "list_repos", "read_file", "fetch_page"])
			expect(getMcpReadOnlyEvidence(name, null)).toBe("name_convention")
	})
	it("annotation_true wins over conflicting destructive and open-world hints", () => {
		expect(
			getMcpReadOnlyEvidence("deploy", {
				readOnlyHint: true,
				destructiveHint: true,
				openWorldHint: true,
			}),
		).toBe("annotation_true")
	})
})

describe("collectReadOnlyMcpWireNames", () => {
	function wireNames(config: McpConfig, server?: string): string[] {
		return collectReadOnlyMcpWireNames(collectMcpToolCandidates(config, cacheState.cache ?? null), server)
	}

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
		setCache(config, {
			alpha: [{ name: "get_issue" }, { name: "create_issue" }, { name: "stats", annotations: { readOnlyHint: true } }],
			beta: [{ name: "fetch_items" }],
		})
	})

	it("emits qualified wire names and excludes unconfigured servers", () => {
		expect(wireNames(config).sort()).toEqual(["alpha_get_issue", "alpha_stats", "fetch_items"])
		expect(wireNames({ mcpServers: { beta: config.mcpServers.beta } })).toEqual(["fetch_items"])
	})

	it('honours the "mcp" toolPrefix mode', () => {
		expect(wireNames({ ...config, settings: { toolPrefix: "mcp" } })).toEqual([
			"mcp__alpha_get_issue",
			"mcp__alpha_stats",
			"fetch_items",
		])
	})

	it("ignores disabled servers even when their names collide with writable tools", () => {
		const collisionConfig: McpConfig = {
			mcpServers: {
				old: { url: "https://old.example/mcp", disabled: true, toolPrefix: "none" },
				current: { url: "https://current.example/mcp", directTools: true, toolPrefix: "none" },
			},
		}
		setCache(collisionConfig, {
			old: [{ name: "get_access", annotations: { readOnlyHint: true } }],
			current: [{ name: "get_access", annotations: { readOnlyHint: false } }],
		})
		expect(wireNames(collisionConfig)).toEqual([])
	})

	it("rejects ambiguous wire names across enabled servers", () => {
		const collisionConfig = { ...config, settings: { toolPrefix: "none" as const } }
		setCache(collisionConfig, {
			alpha: [{ name: "get_access", annotations: { readOnlyHint: false } }],
			beta: [{ name: "get_access", annotations: { readOnlyHint: true } }],
		})
		expect(wireNames(collisionConfig)).toEqual([])
		expect(wireNames(collisionConfig, "beta")).toEqual([])
	})

	it("qualifies only the named server's tools for a gateway call that names one", () => {
		expect(wireNames(config, "alpha").sort()).toEqual(["alpha_get_issue", "alpha_stats"])
		expect(wireNames(config, "beta")).toEqual(["fetch_items"])
		expect(wireNames(config, "missing")).toEqual([])
	})

	it("ignores metadata from another endpoint or an expired cache", () => {
		const cache = setCache(config, { alpha: [{ name: "get_issue" }], beta: [{ name: "get_issue" }] })
		cache.servers.alpha.configHash = "another-endpoint"
		// adapter 5.x: entries without a server-declared TTL stay valid until the
		// next connect refresh; expiry is driven by ttlMs now.
		cache.servers.beta.ttlMs = 1000
		cache.servers.beta.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
		expect(wireNames(config)).toEqual([])
	})

	it("rejects sanitized-name collisions within a server even with direct-tool selection", () => {
		const collisionConfig: McpConfig = {
			mcpServers: { alpha: { ...config.mcpServers.alpha, directTools: ["get_access"] } },
		}
		setCache(collisionConfig, {
			alpha: [
				{ name: "get.access", annotations: { readOnlyHint: true } },
				{ name: "get_access", annotations: { readOnlyHint: false } },
			],
		})
		expect(wireNames(collisionConfig)).toEqual([])
	})

	it("respects tool exclusions and app-only visibility", () => {
		const filteredConfig: McpConfig = {
			mcpServers: { alpha: { ...config.mcpServers.alpha, excludeTools: ["get_issue"] } },
		}
		setCache(filteredConfig, { alpha: [{ name: "get_issue" }, { name: "get_app", uiVisibility: ["app"] }] })
		expect(wireNames(filteredConfig)).toEqual([])
	})

	it("never qualifies gateway or namespace proxy names", () => {
		setCache(config, {
			beta: [
				{ name: "mcp", annotations: { readOnlyHint: true } },
				{ name: "mcp__alpha", annotations: { readOnlyHint: true } },
			],
		})
		expect(wireNames(config)).toEqual([])
	})
})
