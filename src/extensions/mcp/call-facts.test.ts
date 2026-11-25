import { namespaceProxyName } from "pi-mcp-adapter"
import type { McpConfig, ToolPrefix } from "pi-mcp-adapter/types"
import { describe, expect, it, vi } from "vitest"
import { describeMcpCall, describeMcpGatewayInput, type McpCallCatalog, type UnresolvedReason } from "./call-facts.js"
import { GATEWAY_SERVER_NAME } from "./gateway.js"
import type { McpToolCandidate, ReadOnlyEvidence } from "./read-only.js"

const config: McpConfig = {
	mcpServers: {
		docs: { url: "https://docs.example/mcp", directTools: true },
		other: { url: "https://other.example/mcp", directTools: true },
	},
}

function candidate(
	name: string,
	originalName: string,
	evidence: ReadOnlyEvidence,
	serverName = "docs",
	prefix: ToolPrefix = "server",
	annotations?: McpToolCandidate["tool"]["annotations"],
): McpToolCandidate {
	return {
		serverName,
		prefix,
		tool: { name, originalName, description: originalName, annotations },
		evidence,
	}
}

const read = candidate("docs_get_issue", "get_issue", "annotation_true")
const write = candidate("docs_create_issue", "create_issue", "annotation_false")

function catalog(overrides: Partial<McpCallCatalog> = {}): McpCallCatalog {
	return {
		config,
		candidates: [read, write],
		registeredToolNames: new Set(["mcp", "docs_get_issue", "docs_create_issue"]),
		staleServers: new Set<string>(),
		expiresAt: Number.POSITIVE_INFINITY,
		...overrides,
	}
}

function unresolved(via: "direct" | "gateway" | "namespace", why: UnresolvedReason) {
	return { kind: "unresolved", via, why }
}

const metadataCases = [
	["describes empty input as status metadata", {}, "status"],
	["describes server input as server metadata", { server: "docs" }, "server"],
	["describes instructions input as instructions metadata", { instructions: "docs" }, "instructions"],
	[
		"describes describe input with optional server as describe metadata",
		{ describe: "get_issue", server: "docs" },
		"describe",
	],
	[
		"describes search input with supported options as search metadata",
		{
			search: "jira",
			searchMode: "semantic",
			regex: false,
			includeSchemas: true,
			limit: 10,
			offset: 0,
			server: "docs",
		},
		"search",
	],
] as const

describe("describeMcpCall gateway shapes", () => {
	for (const [name, input, op] of metadataCases) {
		it(name, () => {
			expect(describeMcpCall("mcp", input, catalog())).toEqual({ kind: "metadata", op })
		})
	}

	it("resolves nested gateway reads and writes", () => {
		expect(describeMcpCall("mcp", { tool: "get_issue" }, catalog())).toEqual({
			kind: "tool",
			via: "gateway",
			server: "docs",
			tool: "get_issue",
			evidence: "annotation_true",
		})
		expect(describeMcpCall("mcp", { tool: "docs_create_issue" }, catalog())).toEqual({
			kind: "tool",
			via: "gateway",
			server: "docs",
			tool: "create_issue",
			evidence: "annotation_false",
		})
	})

	it("accepts object gateway args", () => {
		expect(describeMcpCall("mcp", { tool: "get_issue", args: { id: "LLM-4358" } }, catalog())).toMatchObject({
			kind: "tool",
			evidence: "annotation_true",
		})
	})

	it("accepts string gateway args", () => {
		expect(describeMcpCall("mcp", { tool: "get_issue", args: '{"id":"LLM-4358"}' }, catalog())).toMatchObject({
			kind: "tool",
			evidence: "annotation_true",
		})
	})
})

describe("describeMcpCall direct tools", () => {
	it("returns not_mcp for an unrelated tool", () => {
		expect(describeMcpCall("bash", { command: "pwd" }, catalog())).toEqual({ kind: "not_mcp" })
	})

	it("resolves a direct tool only by one exact unique displayed wire name", () => {
		expect(describeMcpCall("docs_get_issue", { id: "LLM-4358" }, catalog())).toEqual({
			kind: "tool",
			via: "direct",
			server: "docs",
			tool: "get_issue",
			evidence: "annotation_true",
		})
		expect(describeMcpCall("get_issue", {}, catalog())).toEqual({ kind: "not_mcp" })
		expect(describeMcpCall("mcp__docs_get_issue", {}, catalog())).toEqual(unresolved("namespace", "malformed"))
		expect(describeMcpGatewayInput({ tool: "mcp__docs_get_issue" }, catalog())).toMatchObject({
			kind: "tool",
			server: "docs",
		})
	})

	it.each([
		["reports annotation_true evidence for explicit read-only tools", "annotation_true"],
		["reports annotation_false evidence for explicit write tools", "annotation_false"],
		["reports none evidence when annotations exist without readOnlyHint true", "none"],
		["reports unannotated evidence for non-convention names without annotations", "unannotated"],
		["reports name_convention evidence for unannotated conventional names", "name_convention"],
		["reports resource evidence for generated resource-read tools", "resource"],
	] as const)("%s", (_name, evidence) => {
		const tool = candidate("docs_lookup", "lookup", evidence)
		expect(
			describeMcpCall(
				"docs_lookup",
				{},
				catalog({ candidates: [tool], registeredToolNames: new Set(["docs_lookup"]) }),
			),
		).toEqual({
			kind: "tool",
			via: "direct",
			server: "docs",
			tool: "lookup",
			evidence,
		})
	})

	it("annotation_true wins over conflicting hints during call resolution", () => {
		const tool = candidate("docs_deploy", "deploy", "annotation_true", "docs", "server", {
			readOnlyHint: true,
			destructiveHint: true,
			openWorldHint: true,
		})
		expect(
			describeMcpCall(
				"docs_deploy",
				{},
				catalog({ candidates: [tool], registeredToolNames: new Set(["docs_deploy"]) }),
			),
		).toMatchObject({ kind: "tool", evidence: "annotation_true" })
	})
})

describe("describeMcpCall namespace tools", () => {
	it("resolves a namespace nested tool on its single enabled owner", () => {
		expect(describeMcpCall("mcp__docs", { tool: "get_issue", args: { id: "LLM-4358" } }, catalog())).toEqual({
			kind: "tool",
			via: "namespace",
			server: "docs",
			tool: "get_issue",
			evidence: "annotation_true",
		})
	})

	it("resolves Studio connector calls through kimchi-mcp-gateway", () => {
		const studioConfig: McpConfig = { mcpServers: { [GATEWAY_SERVER_NAME]: { url: "https://api.cast.ai/mcp" } } }
		const studioTool = candidate(
			"kimchi_mcp_gateway_getJiraIssue",
			"getJiraIssue",
			"annotation_true",
			GATEWAY_SERVER_NAME,
		)
		const studioCatalog = catalog({ config: studioConfig, candidates: [studioTool] })
		expect(describeMcpCall("mcp", { tool: "getJiraIssue", server: GATEWAY_SERVER_NAME }, studioCatalog)).toEqual({
			kind: "tool",
			via: "gateway",
			server: GATEWAY_SERVER_NAME,
			tool: "getJiraIssue",
			evidence: "annotation_true",
		})
	})

	it("resolves sanitized and long namespace names with namespaceProxyName", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const servers = ["Atlassian Rovo", "a".repeat(128)]
		const namespacedConfig: McpConfig = {
			mcpServers: Object.fromEntries(
				servers.map((server) => [server, { url: `https://${server.length}.example/mcp` }]),
			),
		}
		const candidates = servers.map((server) => candidate("unused", "get_issue", "annotation_true", server))
		for (const server of servers) {
			const proxy = namespaceProxyName(server)
			expect(
				describeMcpCall(
					proxy,
					{ tool: "get_issue" },
					catalog({
						config: namespacedConfig,
						candidates,
						registeredToolNames: new Set(servers.map(namespaceProxyName)),
					}),
				),
			).toEqual({
				kind: "tool",
				via: "namespace",
				server,
				tool: "get_issue",
				evidence: "annotation_true",
			})
		}
		warn.mockRestore()
	})
})

describe("describeMcpCall unresolved calls", () => {
	it("returns unknown for missing tools and servers", () => {
		expect(describeMcpCall("mcp", { tool: "missing" }, catalog())).toEqual(unresolved("gateway", "unknown"))
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "missing" }, catalog())).toEqual(
			unresolved("gateway", "unknown"),
		)
		expect(describeMcpCall("mcp__missing", { tool: "get_issue" }, catalog())).toEqual(
			unresolved("namespace", "unknown"),
		)
	})

	it("returns ambiguous for direct and gateway name collisions", () => {
		const colliding = [
			candidate("get_issue", "get_issue", "annotation_true", "docs", "none"),
			candidate("get_issue", "get_issue", "annotation_false", "other", "none"),
		]
		const collisionCatalog = catalog({ candidates: colliding, registeredToolNames: new Set(["get_issue"]) })
		expect(describeMcpCall("get_issue", {}, collisionCatalog)).toEqual(unresolved("direct", "ambiguous"))
		expect(describeMcpCall("mcp", { tool: "get_issue" }, collisionCatalog)).toEqual(unresolved("gateway", "ambiguous"))
	})

	it("does not fall through from a prefixed gateway miss to global legacy aliases", () => {
		const aliased = candidate("docs-write", "docs-write", "annotation_true", "other", "none")
		const aliasedCatalog = catalog({
			config: {
				mcpServers: {
					docs: config.mcpServers.docs,
					other: { ...config.mcpServers.other, toolPrefix: "none" },
				},
			},
			candidates: [read, write, aliased],
		})
		expect(describeMcpCall("mcp", { tool: "docs_write" }, aliasedCatalog)).toEqual(unresolved("gateway", "unknown"))
	})

	it("returns ambiguous instead of using global legacy aliases for a colliding sanitized prefix", () => {
		const collidingConfig: McpConfig = {
			mcpServers: {
				"my-server": { url: "https://dash.example/mcp" },
				my_server: { url: "https://underscore.example/mcp" },
			},
		}
		const legacyCandidate = candidate("my_server_get-issue", "get-issue", "annotation_true", "my-server")
		expect(
			describeMcpCall(
				"mcp",
				{ tool: "my_server_get_issue" },
				catalog({ config: collidingConfig, candidates: [legacyCandidate] }),
			),
		).toEqual(unresolved("gateway", "ambiguous"))
	})

	it("returns ambiguous for colliding namespace owners", () => {
		const collidingConfig: McpConfig = {
			mcpServers: {
				"my-server": { url: "https://dash.example/mcp" },
				my_server: { url: "https://underscore.example/mcp" },
			},
		}
		expect(namespaceProxyName("my-server")).toBe(namespaceProxyName("my_server"))
		expect(describeMcpCall("mcp__my_server", { tool: "get_issue" }, catalog({ config: collidingConfig }))).toEqual(
			unresolved("namespace", "ambiguous"),
		)
	})

	it("returns stale for expired or config-mismatched metadata", () => {
		const stale = catalog({ candidates: [read], staleServers: new Set(["docs"]) })
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, stale)).toEqual(unresolved("gateway", "stale"))
		expect(describeMcpCall("mcp", { tool: "docs_get_issue" }, stale)).toEqual(unresolved("gateway", "stale"))
		expect(describeMcpCall("docs_get_issue", {}, stale)).toEqual(unresolved("direct", "stale"))
	})

	it("returns disabled for a call scoped to a disabled server", () => {
		const disabled = catalog({
			config: { mcpServers: { ...config.mcpServers, docs: { ...config.mcpServers.docs, disabled: true } } },
			candidates: [read],
		})
		expect(describeMcpCall("mcp", { tool: "get_issue", server: "docs" }, disabled)).toEqual(
			unresolved("gateway", "disabled"),
		)
		expect(describeMcpCall("mcp", { tool: "docs_get_issue" }, disabled)).toEqual(unresolved("gateway", "disabled"))
		expect(describeMcpCall("docs_get_issue", {}, disabled)).toEqual(unresolved("direct", "disabled"))
		expect(describeMcpCall("mcp__docs", { tool: "get_issue" }, disabled)).toEqual(unresolved("namespace", "disabled"))
	})

	it("returns action for gateway action input", () => {
		expect(describeMcpCall("mcp", { action: "install", url: "https://example.test/mcp" }, catalog())).toEqual(
			unresolved("gateway", "action"),
		)
	})

	it("rejects mixed metadata operations as malformed", () => {
		for (const input of [
			{ search: "issue", describe: "get_issue" },
			{ instructions: "docs", server: "docs" },
			{ search: "issue", connect: "docs" },
		]) {
			expect(describeMcpCall("mcp", input, catalog())).toEqual(unresolved("gateway", "malformed"))
		}
	})

	it("rejects unknown gateway fields as malformed", () => {
		for (const input of [{ mode: "status" }, { search: "issue", unknown: true }, { describe: "get_issue", args: {} }]) {
			expect(describeMcpCall("mcp", input, catalog())).toEqual(unresolved("gateway", "malformed"))
		}
	})

	it("rejects malformed metadata values as malformed", () => {
		const inputs: unknown[] = [
			null,
			[],
			"status",
			{ server: "" },
			{ server: 1 },
			{ instructions: null },
			{ describe: [] },
			{ describe: "get_issue", server: "" },
			{ search: false },
			{ search: "issue", searchMode: 1 },
			{ search: "issue", regex: "false" },
			{ search: "issue", includeSchemas: 1 },
			{ search: "issue", limit: -1 },
			{ search: "issue", limit: 1.5 },
			{ search: "issue", offset: -1 },
			{ search: "issue", offset: Number.NaN },
			{ search: "issue", limit: 0 },
			{ search: "issue", searchMode: "fuzzy" },
			{ search: "issue", searchMode: "semantic", regex: true },
		]
		for (const input of inputs) {
			expect(describeMcpCall("mcp", input, catalog()), JSON.stringify(input)).toEqual(
				unresolved("gateway", "malformed"),
			)
		}
	})

	it("rejects install auth reconnect and connect inputs as unresolved", () => {
		for (const input of [
			{ install: "https://example.test/mcp" },
			{ auth: "docs" },
			{ reconnect: "docs" },
			{ connect: "docs" },
		]) {
			expect(describeMcpCall("mcp", input, catalog())).toEqual(unresolved("gateway", "action"))
		}
	})

	it("rejects malformed nested tool and args values as malformed", () => {
		const gatewayInputs: unknown[] = [
			{ tool: "" },
			{ tool: 1 },
			{ tool: "get_issue", server: "" },
			{ tool: "get_issue", args: null },
			{ tool: "get_issue", args: [] },
			{ tool: "get_issue", args: 1 },
			{ tool: "get_issue", extra: true },
			{ tool: "get_issue", args: "{not json" },
			{ tool: "get_issue", args: "[]" },
			{ tool: "get_issue", args: "null" },
			{ tool: "get_issue", args: "1" },
		]
		for (const input of gatewayInputs) {
			expect(describeMcpCall("mcp", input, catalog()), JSON.stringify(input)).toEqual(
				unresolved("gateway", "malformed"),
			)
		}
		const namespaceInputs: unknown[] = [
			{ tool: "get_issue", server: "docs" },
			{ tool: "get_issue", args: null },
			{ args: {} },
			{ tool: "get_issue", args: '{"id":"X"}' },
			{ tool: "get_issue", args: "" },
		]
		for (const input of namespaceInputs) {
			expect(describeMcpCall("mcp__docs", input, catalog()), JSON.stringify(input)).toEqual(
				unresolved("namespace", "malformed"),
			)
		}
	})

	it("accepts every input shape the adapter accepts", () => {
		const readFacts = (via: "gateway" | "namespace") => ({
			kind: "tool",
			via,
			server: "docs",
			tool: "get_issue",
			evidence: "annotation_true",
		})
		expect(describeMcpCall("mcp", { tool: "get_issue", args: '{"id":"X"}' }, catalog())).toEqual(readFacts("gateway"))
		expect(describeMcpCall("mcp", { tool: "get_issue", args: "" }, catalog())).toEqual(readFacts("gateway"))
		for (const input of [
			{ search: "issue", limit: 1, offset: 0, searchMode: "semantic" },
			{ search: "issue", searchMode: "lexical" },
			{ search: "issue", searchMode: "semantic", regex: false },
		]) {
			expect(describeMcpCall("mcp", input, catalog()), JSON.stringify(input)).toEqual({
				kind: "metadata",
				op: "search",
			})
		}
		expect(describeMcpCall("mcp__docs", { tool: "get_issue", args: { id: "X" } }, catalog())).toEqual(
			readFacts("namespace"),
		)
	})
})
