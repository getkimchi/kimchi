import { beforeEach, describe, expect, it, vi } from "vitest"
import type * as ConfigModule from "../../config.js"
import type { ServerEntry } from "./types.js"

const configState = vi.hoisted(() => ({
	environmentKey: undefined as string | undefined,
	savedKey: undefined as string | undefined,
	castApiUrl: "https://api.cast.ai",
}))
const regionsState = vi.hoisted(() => ({
	regions: {} as Record<string, { castApiUrl: string }>,
}))
const resourceState = vi.hoisted(() => ({ enabled: false }))

vi.mock("../../config.js", () => ({
	getEnvironmentApiKey: () => configState.environmentKey,
	readApiKeyFromConfigFile: () => configState.savedKey,
	resolveEndpoints: () =>
		({ castApiUrl: configState.castApiUrl }) satisfies Pick<ConfigModule.ResolvedEndpoints, "castApiUrl">,
}))

vi.mock("../../regions.js", () => ({
	get REGIONS() {
		return regionsState.regions
	},
}))

vi.mock("../../resources/store.js", () => ({
	isResourceEnabled: vi.fn(() => resourceState.enabled),
}))

import {
	buildGatewayRegistration,
	GATEWAY_SERVER_NAME,
	getGatewayAddresses,
	hasGatewayAddress,
	KIMCHI_MCP_GATEWAY_RESOURCE_ID,
	normalizeServerUrl,
} from "./gateway.js"

function configWith(...urls: (string | undefined)[]): Record<string, ServerEntry> {
	return Object.fromEntries(
		urls.map((url, index) => [`server-${index}`, url === undefined ? { command: "stdio-server" } : { url }]),
	)
}

describe("buildGatewayRegistration", () => {
	beforeEach(() => {
		configState.environmentKey = undefined
		configState.savedKey = undefined
		configState.castApiUrl = "https://api.cast.ai"
		regionsState.regions = {
			us: { castApiUrl: "https://api.cast.ai" },
			eu: { castApiUrl: "https://api.eu.cast.ai" },
			"self-hosted": { castApiUrl: "" },
		}
		resourceState.enabled = false
	})

	it("exposes the resource id used by /resources", () => {
		expect(KIMCHI_MCP_GATEWAY_RESOURCE_ID).toBe("plugins.kimchi-mcp-gateway")
	})

	it("returns undefined when the resource is disabled, even with a key and URL", () => {
		configState.environmentKey = "castai_v1_key"
		expect(buildGatewayRegistration()).toBeUndefined()
	})

	it("returns undefined when no API key is configured", () => {
		resourceState.enabled = true
		expect(buildGatewayRegistration()).toBeUndefined()
	})

	it("returns undefined on self-hosted (empty castApiUrl)", () => {
		resourceState.enabled = true
		configState.savedKey = "castai_v1_key"
		configState.castApiUrl = ""
		expect(buildGatewayRegistration()).toBeUndefined()
	})

	it("returns undefined for an http (non-https) base", () => {
		resourceState.enabled = true
		configState.savedKey = "castai_v1_key"
		configState.castApiUrl = "http://api.cast.ai"
		expect(buildGatewayRegistration()).toBeUndefined()
	})

	it("returns undefined for a schemeless base", () => {
		resourceState.enabled = true
		configState.savedKey = "castai_v1_key"
		configState.castApiUrl = "kimchi.internal/api"
		expect(buildGatewayRegistration()).toBeUndefined()
	})

	it("builds the region-derived URL and bearer header from the saved key", () => {
		resourceState.enabled = true
		configState.savedKey = "castai_v1_saved"
		configState.castApiUrl = "https://api.eu.cast.ai"
		expect(buildGatewayRegistration()).toEqual({
			name: GATEWAY_SERVER_NAME,
			config: {
				type: "http",
				url: "https://api.eu.cast.ai/mcp",
				headers: { Authorization: "Bearer castai_v1_saved" },
				exposure: "direct",
			},
		})
	})

	it("prefers the KIMCHI_API_KEY environment key over the saved key", () => {
		resourceState.enabled = true
		configState.environmentKey = "castai_v1_env"
		configState.savedKey = "castai_v1_saved"
		const built = buildGatewayRegistration()
		expect((built?.config as { headers?: Record<string, string> }).headers?.Authorization).toBe("Bearer castai_v1_env")
	})

	it("normalizes trailing slashes on the Cast AI API base", () => {
		resourceState.enabled = true
		configState.savedKey = "castai_v1_key"
		configState.castApiUrl = "https://api.cast.ai///"
		expect((buildGatewayRegistration()?.config as { url?: string }).url).toBe("https://api.cast.ai/mcp")
	})
})

describe("getGatewayAddresses", () => {
	beforeEach(() => {
		regionsState.regions = {
			us: { castApiUrl: "https://api.cast.ai" },
			eu: { castApiUrl: "https://api.eu.cast.ai" },
			"self-hosted": { castApiUrl: "" },
		}
		configState.castApiUrl = "https://api.cast.ai"
	})

	it("covers every region with a URL plus the active deployment's derived URL", () => {
		expect(getGatewayAddresses()).toEqual(["https://api.cast.ai/mcp", "https://api.eu.cast.ai/mcp"])
	})

	it("adds the active self-hosted gateway URL", () => {
		configState.castApiUrl = "https://kimchi.example.com/api"
		expect(getGatewayAddresses()).toContain("https://kimchi.example.com/api/mcp")
	})
})

describe("hasGatewayAddress", () => {
	const addresses = ["https://api.cast.ai/mcp", "https://api.eu.cast.ai/mcp"]

	it("matches an exact gateway URL", () => {
		expect(hasGatewayAddress(configWith("https://api.cast.ai/mcp"), addresses)).toBe(true)
	})

	it("ignores URL case and trailing slashes", () => {
		expect(hasGatewayAddress(configWith("HTTPS://API.CAST.AI/MCP/"), addresses)).toBe(true)
	})

	it("matches a gateway URL under a different region than the active one", () => {
		expect(hasGatewayAddress(configWith("https://api.eu.cast.ai/mcp"), addresses)).toBe(true)
	})

	it("matches an explicit default port against the portless form", () => {
		expect(hasGatewayAddress(configWith("https://api.cast.ai:443/mcp"), addresses)).toBe(true)
	})

	it("does not match a different path, host, scheme, or scheme-relative URL", () => {
		expect(hasGatewayAddress(configWith("https://api.cast.ai/mcp/v2"), addresses)).toBe(false)
		expect(hasGatewayAddress(configWith("https://gateway.example.com/mcp"), addresses)).toBe(false)
		expect(hasGatewayAddress(configWith("http://api.cast.ai/mcp"), addresses)).toBe(false)
	})

	it("ignores servers without a URL (stdio)", () => {
		expect(hasGatewayAddress(configWith(undefined), addresses)).toBe(false)
	})

	it("returns false for an empty config", () => {
		expect(hasGatewayAddress({}, addresses)).toBe(false)
	})
})

describe("normalizeServerUrl", () => {
	it("drops query strings and hashes", () => {
		expect(normalizeServerUrl("https://api.cast.ai/mcp?x=1#frag")).toBe("https://api.cast.ai/mcp")
	})

	it("returns undefined for unparseable and non-HTTP URLs", () => {
		expect(normalizeServerUrl("not a url")).toBeUndefined()
		expect(normalizeServerUrl("ftp://api.cast.ai/mcp")).toBeUndefined()
	})
})
