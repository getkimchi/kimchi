import { namespaceProxyName } from "pi-mcp-adapter"
import { computeServerHash, reconstructToolMetadata } from "pi-mcp-adapter/metadata-cache"
import {
	getToolNameCandidates,
	type McpConfig,
	type MetadataCache,
	resolveToolPrefix,
	type ServerCacheEntry,
	type ToolMetadata,
} from "pi-mcp-adapter/types"
import { describe, expect, it } from "vitest"
import { executeCall } from "../../../node_modules/pi-mcp-adapter/proxy-modes.ts"
import { describeMcpCall, type McpCallCatalog } from "./call-facts.js"
import { collectMcpToolCandidates } from "./read-only.js"

// Authorization resolves names with a copy of the adapter's executeCall
// precedence. These tests run the real executeCall so an adapter upgrade that
// changes the precedence fails here instead of approving a different tool.

const config: McpConfig = {
	mcpServers: {
		docs: { url: "https://docs.example/mcp" },
		docs_cloud: { url: "https://docs-cloud.example/mcp" },
		"linear-mcp": { url: "https://linear.example/mcp", toolPrefix: "short" },
		raw: { url: "https://raw.example/mcp", toolPrefix: "none" },
	},
}

const readOnly = { readOnlyHint: true }

const toolsByServer: Record<string, ServerCacheEntry["tools"]> = {
	docs: [
		{ name: "get_issue", annotations: readOnly },
		{ name: "get-page", annotations: readOnly },
		{ name: "search", annotations: readOnly },
		{ name: "create_issue", annotations: { readOnlyHint: false } },
		{ name: "lookup", annotations: readOnly },
	],
	docs_cloud: [
		{ name: "get_page", annotations: readOnly },
		{ name: "search", annotations: readOnly },
		{ name: "lookup", annotations: readOnly },
	],
	"linear-mcp": [
		{ name: "list_teams", annotations: readOnly },
		{ name: "get-issue", annotations: readOnly },
	],
	raw: [
		{ name: "search", annotations: readOnly },
		{ name: "docs_get_issue", annotations: readOnly },
	],
}

const cache: MetadataCache = {
	version: 1,
	servers: Object.fromEntries(
		Object.entries(config.mcpServers).map(([serverName, definition]) => [
			serverName,
			{
				configHash: computeServerHash(definition),
				tools: toolsByServer[serverName] ?? [],
				resources: [],
				cachedAt: Date.now(),
			},
		]),
	),
}

const catalog: McpCallCatalog = {
	config,
	candidates: collectMcpToolCandidates(config, cache),
	registeredToolNames: new Set(["mcp"]),
	staleServers: new Set(),
}

type AdapterState = Parameters<typeof executeCall>[0]

// Every server is in failure backoff with no connection. executeCall then
// resolves the target from metadata only and returns its identity in the
// server_backoff result, without connecting or calling the tool.
function adapterState(): AdapterState {
	const toolMetadata = new Map<string, ToolMetadata[]>()
	const failureTracker = new Map<string, number>()
	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const entry = cache.servers[serverName]
		if (entry === undefined) throw new Error(`missing cache entry for ${serverName}`)
		const prefix = resolveToolPrefix(definition, config.settings?.toolPrefix)
		toolMetadata.set(
			serverName,
			reconstructToolMetadata(serverName, entry, prefix, definition, config.mcpServers, cache),
		)
		failureTracker.set(serverName, Date.now())
	}
	const stub = {
		config,
		toolMetadata,
		failureTracker,
		failureMessages: new Map<string, string>(),
		manager: { getConnection: () => undefined },
		owner: { signal: undefined, isActive: () => true },
	}
	// executeCall reads only these fields before it returns server_backoff.
	return stub as unknown as AdapterState
}

type Target = { server: string; tool: string } | undefined

async function adapterTarget(tool: string, server?: string): Promise<Target> {
	const result = await executeCall(adapterState(), tool, {}, server)
	const details = result.details as { error?: string; server?: unknown; tool?: unknown }
	if (details.error !== "server_backoff") return undefined
	return typeof details.server === "string" && typeof details.tool === "string"
		? { server: details.server, tool: details.tool }
		: undefined
}

function ourTarget(toolName: string, input: unknown): Target {
	const facts = describeMcpCall(toolName, input, catalog)
	return facts.kind === "tool" ? { server: facts.server, tool: facts.tool } : undefined
}

function nameCorpus(): string[] {
	const names = new Set<string>(["missing_tool", "docs_missing", "linear_missing"])
	for (const candidate of catalog.candidates) {
		names.add(candidate.tool.name)
		names.add(candidate.tool.originalName)
		for (const alias of getToolNameCandidates(candidate.tool.originalName, candidate.serverName, candidate.prefix)) {
			names.add(alias)
		}
	}
	return [...names].sort()
}

const servers = [undefined, ...Object.keys(config.mcpServers)]

describe("MCP call resolution parity with the adapter executeCall", () => {
	it("resolves the gateway tool the adapter would call for every name and server", async () => {
		let resolved = 0
		for (const tool of nameCorpus()) {
			for (const server of servers) {
				const ours = ourTarget("mcp", server === undefined ? { tool } : { tool, server })
				if (ours === undefined) continue
				resolved++
				expect({ tool, server, target: await adapterTarget(tool, server) }).toEqual({ tool, server, target: ours })
			}
		}
		// Guards against a corpus where nothing resolves and the loop proves nothing.
		expect(resolved).toBeGreaterThan(20)
	})

	it("resolves the namespace tool the adapter would call for every name", async () => {
		let resolved = 0
		for (const tool of nameCorpus()) {
			for (const server of Object.keys(config.mcpServers)) {
				const ours = ourTarget(namespaceProxyName(server), { tool })
				if (ours === undefined) continue
				resolved++
				expect({ tool, server, target: await adapterTarget(tool, server) }).toEqual({ tool, server, target: ours })
			}
		}
		expect(resolved).toBeGreaterThan(10)
	})

	const precedenceCases: Array<[string, string, string | undefined, Target]> = [
		["exact displayed name over original names", "search", undefined, { server: "raw", tool: "search" }],
		["original name", "get_issue", undefined, { server: "docs", tool: "get_issue" }],
		["longest server prefix", "docs_cloud_get_page", undefined, { server: "docs_cloud", tool: "get_page" }],
		["short prefix", "linear_list_teams", undefined, { server: "linear-mcp", tool: "list_teams" }],
		["legacy hyphen alias", "docs_get_page", undefined, { server: "docs", tool: "get-page" }],
		["explicit server", "search", "docs_cloud", { server: "docs_cloud", tool: "search" }],
	]

	for (const [name, tool, server, expected] of precedenceCases) {
		it(`agrees on ${name}`, async () => {
			const input = server === undefined ? { tool } : { tool, server }
			expect(ourTarget("mcp", input)).toEqual(expected)
			expect(await adapterTarget(tool, server)).toEqual(expected)
		})
	}

	const collisionCases: Array<[string, string]> = [
		["displayed-name", "docs_get_issue"],
		["original-name", "lookup"],
	]

	for (const [name, tool] of collisionCases) {
		it(`treats a cross-server ${name} collision as ambiguous on both sides`, async () => {
			expect(describeMcpCall("mcp", { tool }, catalog)).toMatchObject({ kind: "unresolved", why: "ambiguous" })
			const result = await executeCall(adapterState(), tool, {})
			expect(result.details).toMatchObject({ error: "ambiguous_tool" })
		})
	}
})
