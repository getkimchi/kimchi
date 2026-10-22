import { afterEach, describe, expect, it } from "vitest"
import {
	clearPendingOAuthRegion,
	oauthConfigForRegion,
	resolveOAuthLoginConfig,
	setPendingOAuthRegion,
	ssoAvailableRegions,
} from "./oauth-config.js"
import { REGIONS } from "./regions.js"

const ENV_KEYS = [
	"KIMCHI_OAUTH_CLIENT_ID",
	"KIMCHI_OAUTH_CLIENT_ID_US",
	"KIMCHI_OAUTH_CLIENT_ID_EU",
	"KIMCHI_OAUTH_AUTHORIZE_URL",
	"KIMCHI_OAUTH_TOKEN_URL",
	"KIMCHI_OAUTH_AUDIENCE",
	"KIMCHI_ORGANIZATIONS_URL",
	"KIMCHI_OAUTH_USE_ID_TOKEN",
] as const

afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key]
	clearPendingOAuthRegion()
})

describe("oauthConfigForRegion", () => {
	it("returns the US Auth0 tenant defaults with default ID-token as the gateway bearer", () => {
		const cfg = oauthConfigForRegion(REGIONS.us)
		expect(cfg).toEqual({
			region: "us",
			authorizeUrl: "https://login.cast.ai/authorize",
			tokenUrl: "https://login.cast.ai/oauth/token",
			clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
			audience: undefined,
			organizationsUrl: "https://api.cast.ai/v1/organizations",
			useIdToken: true,
		})
	})

	it("returns the EU Auth0 tenant defaults", () => {
		const cfg = oauthConfigForRegion(REGIONS.eu)
		expect(cfg?.authorizeUrl).toBe("https://login.eu.cast.ai/authorize")
		expect(cfg?.tokenUrl).toBe("https://login.eu.cast.ai/oauth/token")
		expect(cfg?.clientId).toBe("Bw2sA2DJyUAN2wpGiHU72Wh2Xenw6xma")
		expect(cfg?.organizationsUrl).toBe("https://api.eu.cast.ai/v1/organizations")
	})

	it("returns undefined for self-hosted (no Auth0 tenant)", () => {
		expect(oauthConfigForRegion(REGIONS["self-hosted"])).toBeUndefined()
	})

	it("applies per-region client id override over global and defaults", () => {
		process.env.KIMCHI_OAUTH_CLIENT_ID = "global-id"
		process.env.KIMCHI_OAUTH_CLIENT_ID_US = "us-id"
		expect(oauthConfigForRegion(REGIONS.us)?.clientId).toBe("us-id")
		expect(oauthConfigForRegion(REGIONS.eu)?.clientId).toBe("global-id")
		delete process.env.KIMCHI_OAUTH_CLIENT_ID_US
		expect(oauthConfigForRegion(REGIONS.us)?.clientId).toBe("global-id")
	})

	it("applies authorize/token/audience/organizations overrides (mock-AS dev use)", () => {
		process.env.KIMCHI_OAUTH_AUTHORIZE_URL = "http://127.0.0.1:9876/authorize"
		process.env.KIMCHI_OAUTH_TOKEN_URL = "http://127.0.0.1:9876/token"
		process.env.KIMCHI_OAUTH_AUDIENCE = "https://llm.kimchi.dev"
		process.env.KIMCHI_ORGANIZATIONS_URL = "http://127.0.0.1:9876/v1/organizations"
		const cfg = oauthConfigForRegion(REGIONS.us)
		expect(cfg?.authorizeUrl).toBe("http://127.0.0.1:9876/authorize")
		expect(cfg?.tokenUrl).toBe("http://127.0.0.1:9876/token")
		expect(cfg?.audience).toBe("https://llm.kimchi.dev")
		expect(cfg?.organizationsUrl).toBe("http://127.0.0.1:9876/v1/organizations")
	})

	it("parses KIMCHI_OAUTH_USE_ID_TOKEN as a boolean", () => {
		expect(oauthConfigForRegion(REGIONS.us)?.useIdToken).toBe(true)
		process.env.KIMCHI_OAUTH_USE_ID_TOKEN = "false"
		expect(oauthConfigForRegion(REGIONS.us)?.useIdToken).toBe(false)
		process.env.KIMCHI_OAUTH_USE_ID_TOKEN = "1"
		expect(oauthConfigForRegion(REGIONS.us)?.useIdToken).toBe(true)
	})

	it("ignores blank env values", () => {
		process.env.KIMCHI_OAUTH_CLIENT_ID = "   "
		expect(oauthConfigForRegion(REGIONS.us)?.clientId).toBe("rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS")
	})
})

describe("ssoAvailableRegions", () => {
	it("keeps only regions with OAuth metadata", () => {
		const all = [REGIONS.us, REGIONS.eu, REGIONS["self-hosted"]]
		expect(ssoAvailableRegions(all).map((r) => r.id)).toEqual(["us", "eu"])
	})

	it("returns an empty list when nothing is offered", () => {
		expect(ssoAvailableRegions([])).toEqual([])
	})
})

describe("resolveOAuthLoginConfig", () => {
	it("prefers the pending selector region over the stored region", () => {
		setPendingOAuthRegion("eu")
		expect(resolveOAuthLoginConfig("us")?.region).toBe("eu")
	})

	it("falls back to the stored region", () => {
		expect(resolveOAuthLoginConfig("us")?.region).toBe("us")
	})

	it("returns undefined for self-hosted and missing regions", () => {
		expect(resolveOAuthLoginConfig("self-hosted")).toBeUndefined()
		expect(resolveOAuthLoginConfig(undefined)).toBeUndefined()
		setPendingOAuthRegion("self-hosted")
		expect(resolveOAuthLoginConfig("us")).toBeUndefined()
	})

	it("clearPendingOAuthRegion clears a pending selection", () => {
		setPendingOAuthRegion("eu")
		clearPendingOAuthRegion()
		expect(resolveOAuthLoginConfig("us")?.region).toBe("us")
	})
})
