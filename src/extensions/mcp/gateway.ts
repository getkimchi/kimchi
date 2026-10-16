/**
 * The built-in Cast AI MCP gateway (Jira, Confluence, and more), registered
 * with pi 1.3's native MCP extension (`pi.registerMcpServer`) when the
 * `plugins.kimchi-mcp-gateway` resource is enabled and credentials exist.
 * Pre-1.3 this was injected into the pi-mcp-adapter config; the registration
 * surface changed, the server shape did not.
 */
import type { McpServerConfig } from "@earendil-works/pi-coding-agent"
import { getEnvironmentApiKey, readApiKeyFromConfigFile, resolveEndpoints } from "../../config.js"
import { REGIONS } from "../../regions.js"
import { isResourceEnabled } from "../../resources/store.js"
import type { ServerEntry } from "./types.js"

export const KIMCHI_MCP_GATEWAY_RESOURCE_ID = "plugins.kimchi-mcp-gateway"

/** Cosmetic — conflict detection is by address, not name. */
export const GATEWAY_SERVER_NAME = "kimchi-mcp-gateway"

/** Path appended to a region's Cast AI API base to reach the MCP gateway. */
const GATEWAY_PATH = "/mcp"

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
		return false
	}
}

/**
 * Normalizes a candidate server URL for address comparison: origin plus
 * path, lowercased, no trailing slash, no query/hash. Unparseable or
 * non-HTTP(S) URLs normalize to undefined.
 */
export function normalizeServerUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined
		const path = parsed.pathname.replace(/\/+$/, "")
		return `${parsed.origin}${path}`.toLowerCase()
	} catch {
		return undefined
	}
}

/**
 * Every gateway endpoint URL the harness may inject: the active
 * deployment's derived URL plus each static region's, so a manual entry
 * created under a different region still suppresses the built-in.
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

export interface GatewayRegistration {
	name: string
	config: McpServerConfig
	/** Bearer token used for the Authorization header; callers pass it to the URL's credentials, never into logs. */
}

/**
 * The built-in gateway registration, or undefined when it must not be
 * registered: resource disabled, no API key, or no gateway URL for this
 * deployment. Silent skips are deliberate.
 */
export function buildGatewayRegistration(): GatewayRegistration | undefined {
	if (!isResourceEnabled(KIMCHI_MCP_GATEWAY_RESOURCE_ID)) return undefined
	const url = gatewayUrlForCastApi(resolveEndpoints().castApiUrl)
	if (url === undefined || !isSecureUrl(url)) return undefined
	const apiKey = getEnvironmentApiKey() ?? readApiKeyFromConfigFile()
	if (!apiKey) return undefined
	// The explicit Authorization header keeps pi's auto-401 OAuth from starting.
	return {
		name: GATEWAY_SERVER_NAME,
		config: { type: "http", url, headers: { Authorization: `Bearer ${apiKey}` }, exposure: "direct" },
	}
}

/**
 * Whether any configured server already points at one of the gateway
 * addresses. The user's own entry wins by address, not name, so a manually
 * configured gateway (possibly renamed) still suppresses the built-in.
 */
export function hasGatewayAddress(
	servers: Record<string, ServerEntry | McpServerConfig>,
	addresses: readonly string[],
): boolean {
	const gatewayAddresses = new Set(addresses)
	for (const entry of Object.values(servers)) {
		if (typeof entry !== "object" || entry === null) continue
		const url = (entry as { url?: unknown }).url
		if (typeof url !== "string") continue
		const normalized = normalizeServerUrl(url)
		if (normalized !== undefined && gatewayAddresses.has(normalized)) return true
	}
	return false
}
