import type { McpConfig, ServerEntry } from "pi-mcp-adapter/types"
import { getEnvironmentApiKey, readApiKeyFromConfigFile, resolveEndpoints } from "../../config.js"
import { REGIONS } from "../../regions.js"
import { isResourceEnabled } from "../../resources/store.js"

export const KIMCHI_MCP_GATEWAY_RESOURCE_ID = "plugins.kimchi-mcp-gateway"

/**
 * Server name for the injected entry. Cosmetic — conflict detection is by
 * address — but it keeps today's `kimchi_mcp_gateway` tool prefix and
 * matches the name a manual mcp.json setup would have used.
 */
export const GATEWAY_SERVER_NAME = "kimchi-mcp-gateway"

/** Path appended to a region's Cast AI API base to reach the MCP gateway. */
const GATEWAY_PATH = "/mcp"

export interface BuiltInGatewayServer {
	name: string
	entry: ServerEntry
}

function gatewayUrlForCastApi(castApiUrl: string): string | undefined {
	const base = castApiUrl.trim().replace(/\/+$/, "")
	if (base === "") return undefined
	return `${base}${GATEWAY_PATH}`
}

/**
 * The credential is only ever attached to an https endpoint: an http or
 * schemeless base (possible via env overrides or self-hosted config) must
 * never receive the Bearer header.
 */
function isSecureUrl(url: string): boolean {
	try {
		return new URL(url).protocol === "https:"
	} catch {
		// Expected for malformed bases from arbitrary config/env values.
		return false
	}
}

/**
 * Normalizes a candidate server URL for address comparison: origin plus
 * path, lowercased, no trailing slash, no query/hash. Unparseable or
 * non-HTTP(S) URLs normalize to undefined — mcp.json entries are arbitrary
 * user input and stdio entries have no URL at all, so a miss is expected.
 */
export function normalizeServerUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
		const path = parsed.pathname.replace(/\/+$/, "")
		// origin lowercases the host and drops explicit default ports (:443/:80),
		// so portless and default-port forms compare equal.
		return `${parsed.origin}${path}`.toLowerCase()
	} catch {
		// Expected for malformed user-provided URLs; such entries can never
		// collide with the gateway address.
		return undefined
	}
}

/**
 * Every gateway endpoint URL the harness may inject: the active
 * deployment's derived URL (region-resolved, so env overrides and
 * self-hosted bases are covered) plus each static region's, so a manual
 * entry created under a different region still suppresses the built-in.
 */
export function getGatewayAddresses(): string[] {
	const bases = [...Object.values(REGIONS).map((region) => region.castApiUrl), resolveEndpoints().castApiUrl]
	const addresses = bases
		.map(gatewayUrlForCastApi)
		.filter((url) => url !== undefined)
		.map(normalizeServerUrl)
		.filter((url) => url !== undefined)
	return [...new Set(addresses)]
}

/**
 * The built-in gateway server, or undefined when it must not be registered:
 * resource disabled, no API key (KIMCHI_API_KEY env or the saved config.json
 * key — the same credential the harness uses for LLM auth), or no gateway
 * URL for this deployment (self-hosted without a base URL). Silent skips are
 * deliberate: the gateway is optional, like any user-configured MCP server.
 */
export function buildBuiltinGatewayServer(): BuiltInGatewayServer | undefined {
	if (!isResourceEnabled(KIMCHI_MCP_GATEWAY_RESOURCE_ID)) return undefined
	const url = gatewayUrlForCastApi(resolveEndpoints().castApiUrl)
	if (url === undefined || !isSecureUrl(url)) return undefined
	const apiKey = getEnvironmentApiKey() ?? readApiKeyFromConfigFile()
	if (!apiKey) return undefined
	// Custom headers suppress the adapter's OAuth auto-detection for this URL.
	// keep-alive connects at extension load instead of on first tool call (the
	// lazy default serves tools from the disk cache and shows "not listening")
	// and adds health-check reconnects for the remote endpoint.
	return {
		name: GATEWAY_SERVER_NAME,
		entry: { url, headers: { Authorization: `Bearer ${apiKey}` }, lifecycle: "keep-alive" },
	}
}

/**
 * Whether any configured server already points at one of the gateway
 * addresses. The user's own entry wins by address, not name, so a manually
 * configured gateway (possibly renamed) still suppresses the built-in.
 */
export function hasGatewayAddress(config: McpConfig, addresses: readonly string[]): boolean {
	const gatewayAddresses = new Set(addresses)
	for (const entry of Object.values(config.mcpServers)) {
		if (typeof entry.url !== "string") continue
		const normalized = normalizeServerUrl(entry.url)
		if (normalized !== undefined && gatewayAddresses.has(normalized)) return true
	}
	return false
}
