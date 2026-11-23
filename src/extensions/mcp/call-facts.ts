import { namespaceProxyName } from "pi-mcp-adapter"
import {
	getServerPrefix,
	getToolNameCandidates,
	isServerDisabled,
	type McpConfig,
	resolveToolPrefix,
} from "pi-mcp-adapter/types"
import type { McpToolCandidate, ReadOnlyEvidence } from "./read-only.js"

export type UnresolvedReason = "unknown" | "ambiguous" | "stale" | "disabled" | "malformed" | "action"
export type McpCallVia = "direct" | "gateway" | "namespace"
export type McpMetadataOperation = "status" | "server" | "instructions" | "describe" | "search"

export type McpCallFacts =
	| { kind: "not_mcp" }
	| { kind: "metadata"; op: McpMetadataOperation }
	| {
			kind: "tool"
			via: McpCallVia
			server: string
			tool: string
			evidence: ReadOnlyEvidence
	  }
	| { kind: "unresolved"; via: McpCallVia; why: UnresolvedReason }

export type McpGatewayInputFacts =
	| { kind: "metadata"; op: McpMetadataOperation }
	| {
			kind: "tool"
			via: "gateway"
			server: string
			tool: string
			evidence: ReadOnlyEvidence
	  }
	| { kind: "unresolved"; via: "gateway"; why: UnresolvedReason }

export interface McpCallCatalog {
	config: McpConfig
	candidates: readonly McpToolCandidate[]
	registeredToolNames: ReadonlySet<string>
	staleServers: ReadonlySet<string>
	disabledServers: ReadonlySet<string>
}

const SEARCH_KEYS = new Set(["search", "searchMode", "regex", "includeSchemas", "limit", "offset", "server"])
const TOOL_KEYS = new Set(["tool", "args", "server"])
const NESTED_TOOL_KEYS = new Set(["tool", "args"])
const ACTION_KEYS = new Set(["action", "install", "auth", "reconnect", "connect"])
const READ_KEYS = new Set(["server", "instructions", "describe", "search", "tool"])

function isObject(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input)
}

function hasOnlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(input).every((key) => allowed.has(key))
}

function hasValidServer(input: Record<string, unknown>): boolean {
	return input.server === undefined || (typeof input.server === "string" && input.server.length > 0)
}

function hasValidNestedArgs(input: Record<string, unknown>): boolean {
	return input.args === undefined || typeof input.args === "string" || isObject(input.args)
}

function unresolved<T extends McpCallVia>(via: T, why: UnresolvedReason) {
	return { kind: "unresolved" as const, via, why }
}

function resolved(candidate: McpToolCandidate, via: McpCallVia): McpCallFacts {
	return {
		kind: "tool",
		via,
		server: candidate.serverName,
		tool: candidate.tool.originalName,
		evidence: candidate.evidence,
	}
}

function resolveMatches(
	catalog: McpCallCatalog,
	candidates: readonly McpToolCandidate[],
	via: McpCallVia,
): McpCallFacts {
	if (candidates.length === 1 && candidates[0] !== undefined) {
		const problem = serverProblem(catalog, candidates[0].serverName)
		return problem === undefined ? resolved(candidates[0], via) : unresolved(via, problem)
	}
	return unresolved(via, candidates.length === 0 ? "unknown" : "ambiguous")
}

function serverProblem(catalog: McpCallCatalog, serverName: string): UnresolvedReason | undefined {
	const definition = catalog.config.mcpServers[serverName]
	if (definition === undefined) return "unknown"
	if (catalog.disabledServers.has(serverName) || isServerDisabled(definition)) return "disabled"
	if (catalog.staleServers.has(serverName)) return "stale"
	return undefined
}

function resolveOnServer(
	catalog: McpCallCatalog,
	toolName: string,
	serverName: string,
	via: "gateway" | "namespace",
): McpCallFacts {
	const problem = serverProblem(catalog, serverName)
	if (problem !== undefined) return unresolved(via, problem)
	const scoped = catalog.candidates.filter((candidate) => candidate.serverName === serverName)
	const exact = scoped.filter((candidate) => candidate.tool.name === toolName)
	if (exact.length > 0) return resolveMatches(catalog, exact, via)
	return resolveMatches(
		catalog,
		scoped.filter((candidate) =>
			getToolNameCandidates(candidate.tool.originalName, serverName, candidate.prefix).has(toolName),
		),
		via,
	)
}

type PrefixedServerScope = { kind: "none" } | { kind: "server"; serverName: string } | { kind: "ambiguous" }

function prefixedServerScope(config: McpConfig, toolName: string): PrefixedServerScope {
	const candidates = Object.entries(config.mcpServers)
		.filter(([, definition]) => !isServerDisabled(definition))
		.map(([serverName, definition]) => ({
			serverName,
			prefix: getServerPrefix(serverName, resolveToolPrefix(definition, config.settings?.toolPrefix)),
		}))
		.filter(({ prefix }) => prefix.length > 0 && toolName.startsWith(`${prefix}_`))
		.sort((a, b) => b.prefix.length - a.prefix.length)
	if (candidates.length === 0) return { kind: "none" }
	const longest = candidates[0]?.prefix.length
	const best = candidates.filter(({ prefix }) => prefix.length === longest)
	return best.length === 1 && best[0] !== undefined
		? { kind: "server", serverName: best[0].serverName }
		: { kind: "ambiguous" }
}

function resolveGatewayTool(input: Record<string, unknown>, catalog: McpCallCatalog): McpGatewayInputFacts {
	if (
		typeof input.tool !== "string" ||
		input.tool.length === 0 ||
		!hasOnlyKeys(input, TOOL_KEYS) ||
		!hasValidServer(input) ||
		!hasValidNestedArgs(input)
	)
		return unresolved("gateway", "malformed")

	const toolName = input.tool
	const serverName = typeof input.server === "string" ? input.server : undefined
	if (serverName !== undefined) return resolveOnServer(catalog, toolName, serverName, "gateway") as McpGatewayInputFacts

	const exact = catalog.candidates.filter((candidate) => candidate.tool.name === toolName)
	if (exact.length > 0) return resolveMatches(catalog, exact, "gateway") as McpGatewayInputFacts
	const original = catalog.candidates.filter((candidate) => candidate.tool.originalName === toolName)
	if (original.length > 0) return resolveMatches(catalog, original, "gateway") as McpGatewayInputFacts

	const scope = prefixedServerScope(catalog.config, toolName)
	if (scope.kind === "ambiguous") return unresolved("gateway", "ambiguous")
	if (scope.kind === "server")
		return resolveOnServer(catalog, toolName, scope.serverName, "gateway") as McpGatewayInputFacts
	return resolveMatches(
		catalog,
		catalog.candidates.filter((candidate) =>
			getToolNameCandidates(candidate.tool.originalName, candidate.serverName, candidate.prefix).has(toolName),
		),
		"gateway",
	) as McpGatewayInputFacts
}

function isNonnegativeInteger(input: unknown): input is number {
	return typeof input === "number" && Number.isInteger(input) && input >= 0
}

function hasValidSearchOptions(input: Record<string, unknown>): boolean {
	return (
		(input.searchMode === undefined || typeof input.searchMode === "string") &&
		(input.regex === undefined || typeof input.regex === "boolean") &&
		(input.includeSchemas === undefined || typeof input.includeSchemas === "boolean") &&
		(input.limit === undefined || isNonnegativeInteger(input.limit)) &&
		(input.offset === undefined || isNonnegativeInteger(input.offset)) &&
		hasValidServer(input)
	)
}

export function describeMcpGatewayInput(input: unknown, catalog: McpCallCatalog): McpGatewayInputFacts {
	if (!isObject(input)) return unresolved("gateway", "malformed")
	const keys = Object.keys(input)
	if (keys.length === 0) return { kind: "metadata", op: "status" }

	const hasReadKey = keys.some((key) => READ_KEYS.has(key))
	const hasActionKey = keys.some((key) => ACTION_KEYS.has(key))
	if (hasActionKey) return unresolved("gateway", hasReadKey ? "malformed" : "action")
	if (keys.length === 1 && keys[0] === "instructions") {
		return typeof input.instructions === "string"
			? { kind: "metadata", op: "instructions" }
			: unresolved("gateway", "malformed")
	}
	if (keys.length === 1 && keys[0] === "server") {
		return hasValidServer(input) ? { kind: "metadata", op: "server" } : unresolved("gateway", "malformed")
	}
	if (typeof input.describe === "string") {
		return hasOnlyKeys(input, new Set(["describe", "server"])) && hasValidServer(input)
			? { kind: "metadata", op: "describe" }
			: unresolved("gateway", "malformed")
	}
	if (typeof input.search === "string") {
		return hasOnlyKeys(input, SEARCH_KEYS) && hasValidSearchOptions(input)
			? { kind: "metadata", op: "search" }
			: unresolved("gateway", "malformed")
	}
	if (keys.includes("tool")) return resolveGatewayTool(input, catalog)
	return unresolved("gateway", "malformed")
}

function resolveDirect(toolName: string, catalog: McpCallCatalog): McpCallFacts | undefined {
	const exact = catalog.candidates.filter((candidate) => candidate.tool.name === toolName)
	if (exact.length > 1) return unresolved("direct", "ambiguous")
	if (exact.length === 1 && exact[0] !== undefined) {
		return catalog.registeredToolNames.has(toolName)
			? resolveMatches(catalog, exact, "direct")
			: unresolved("direct", "unknown")
	}
	return undefined
}

function resolveRegisteredDirect(toolName: string, catalog: McpCallCatalog): McpCallFacts {
	const scope = prefixedServerScope(catalog.config, toolName)
	if (scope.kind === "server") {
		const problem = serverProblem(catalog, scope.serverName)
		if (problem !== undefined) return unresolved("direct", problem)
	}
	return unresolved("direct", "unknown")
}

function resolveNamespace(toolName: string, input: unknown, catalog: McpCallCatalog): McpCallFacts {
	if (
		!isObject(input) ||
		typeof input.tool !== "string" ||
		input.tool.length === 0 ||
		!hasOnlyKeys(input, NESTED_TOOL_KEYS) ||
		!hasValidNestedArgs(input)
	)
		return unresolved("namespace", "malformed")

	const owners = Object.entries(catalog.config.mcpServers).filter(
		([serverName]) => namespaceProxyName(serverName) === toolName,
	)
	const enabled = owners.filter(
		([serverName, definition]) => !catalog.disabledServers.has(serverName) && !isServerDisabled(definition),
	)
	if (enabled.length > 1) return unresolved("namespace", "ambiguous")
	if (enabled.length === 1 && enabled[0] !== undefined) {
		return resolveOnServer(catalog, input.tool, enabled[0][0], "namespace")
	}
	if (owners.some(([serverName]) => catalog.staleServers.has(serverName))) return unresolved("namespace", "stale")
	if (owners.length > 0) return unresolved("namespace", "disabled")
	return unresolved("namespace", "unknown")
}

export function describeMcpCall(toolName: string, input: unknown, catalog: McpCallCatalog): McpCallFacts {
	if (toolName === "mcp") return describeMcpGatewayInput(input, catalog)
	const direct = resolveDirect(toolName, catalog)
	if (direct !== undefined) return direct
	const isNamespace = Object.keys(catalog.config.mcpServers).some(
		(serverName) => namespaceProxyName(serverName) === toolName,
	)
	if (isNamespace || toolName.startsWith("mcp__")) return resolveNamespace(toolName, input, catalog)
	if (catalog.registeredToolNames.has(toolName)) return resolveRegisteredDirect(toolName, catalog)
	return { kind: "not_mcp" }
}
