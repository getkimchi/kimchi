import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GATEWAY_ORGANIZATION_HEADER, gatewayAuthHeaders, resolveGatewayCredentials } from "./gateway-credentials.js"

let dir: string
let authPath: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gateway-credentials-"))
	authPath = resolve(dir, "auth.json")
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
})

afterEach(() => {
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})

function seedAuth(contents: unknown): void {
	writeFileSync(authPath, typeof contents === "string" ? contents : JSON.stringify(contents))
}

describe("resolveGatewayCredentials", () => {
	it("prefers the config API key over a stored OAuth credential", () => {
		seedAuth({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: "org-1" } })
		const creds = resolveGatewayCredentials({ apiKey: "config-key" })
		expect(creds).toEqual({ token: "config-key", source: "api-key" })
	})

	it("falls back to the stored OAuth access token with its organization id", () => {
		seedAuth({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: "org-1" } })
		const creds = resolveGatewayCredentials({ apiKey: "" })
		expect(creds).toEqual({ token: "oauth-access", organizationId: "org-1", source: "oauth" })
	})

	it("omits organizationId when the OAuth credential has none", () => {
		seedAuth({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r" } })
		const creds = resolveGatewayCredentials({ apiKey: "" })
		expect(creds).toEqual({ token: "oauth-access", organizationId: undefined, source: "oauth" })
	})

	it("reads an api_key credential entry (syncPiAuth fan-out shape)", () => {
		seedAuth({ "kimchi-dev": { type: "api_key", key: "stored-key" } })
		const creds = resolveGatewayCredentials({ apiKey: "" })
		expect(creds).toEqual({ token: "stored-key", source: "api-key" })
	})

	it("resolves from the default auth.json under KIMCHI_CODING_AGENT_DIR", () => {
		seedAuth({ "kimchi-dev": { type: "oauth", access: "oauth-access", refresh: "r", orgId: "org-9" } })
		const creds = resolveGatewayCredentials({ apiKey: "" })
		expect(creds.token).toBe("oauth-access")
		expect(creds.organizationId).toBe("org-9")
	})

	it("honors an explicit authPath over KIMCHI_CODING_AGENT_DIR", () => {
		const otherDir = mkdtempSync(join(tmpdir(), "gateway-credentials-other-"))
		try {
			writeFileSync(resolve(otherDir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "other" } }))
			const creds = resolveGatewayCredentials({ apiKey: "" }, { authPath: resolve(otherDir, "auth.json") })
			expect(creds).toEqual({ token: "other", source: "api-key" })
		} finally {
			rmSync(otherDir, { recursive: true, force: true })
		}
	})

	it("returns source none when auth.json does not exist", () => {
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})

	it("returns source none when KIMCHI_CODING_AGENT_DIR is unset", () => {
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", "")
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})

	it("returns source none when auth.json is malformed JSON (upstream tolerates it)", () => {
		seedAuth("not json {")
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})

	it("returns source none when the OAuth credential has no usable access token", () => {
		seedAuth({ "kimchi-dev": { type: "oauth", refresh: "r" } })
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})

	it("returns source none when the api_key credential has no key", () => {
		seedAuth({ "kimchi-dev": { type: "api_key" } })
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})

	it("ignores credentials of other providers", () => {
		seedAuth({ anthropic: { type: "oauth", access: "other-access", refresh: "r" } })
		expect(resolveGatewayCredentials({ apiKey: "" })).toEqual({ token: "", source: "none" })
	})
})

describe("gatewayAuthHeaders", () => {
	it("builds bearer + organization headers for OAuth", () => {
		const headers = gatewayAuthHeaders({ token: "tok", organizationId: "org-1" })
		expect(headers).toEqual({
			Authorization: "Bearer tok",
			[GATEWAY_ORGANIZATION_HEADER]: "org-1",
		})
	})

	it("omits the organization header for API-key credentials", () => {
		expect(gatewayAuthHeaders({ token: "key" })).toEqual({ Authorization: "Bearer key" })
	})

	it("omits Authorization entirely when tokenless", () => {
		expect(gatewayAuthHeaders({ token: "" })).toEqual({})
	})
})
