import { describe, expect, it } from "vitest"
import { applyOfflineAccessToAuthorizationUrl } from "./oauth-offline-access.js"

type Discovery = Parameters<typeof applyOfflineAccessToAuthorizationUrl>[1]

const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth"
const GENERIC = "https://auth.example.test/authorize"

function authorizeUrl(base: string, params: Record<string, string> = {}): URL {
	const url = new URL(base)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("client_id", "fake-client")
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
	return url
}

function discovery(scopesSupported: unknown): Discovery {
	return {
		authorizationServerUrl: "https://auth.example.test",
		authorizationServerMetadata: { scopes_supported: scopesSupported },
	} as unknown as Discovery
}

describe("applyOfflineAccessToAuthorizationUrl", () => {
	describe("vendor table (stage 2)", () => {
		it("adds Google's offline-access parameters without any discovery state", () => {
			const out = applyOfflineAccessToAuthorizationUrl(authorizeUrl(GOOGLE, { scope: "openid email" }), undefined)
			expect(out.searchParams.get("access_type")).toBe("offline")
			expect(out.searchParams.get("prompt")).toBe("consent")
			expect(out.searchParams.get("scope")).toBe("openid email")
		})

		it("keeps parameters already on the URL (configured authorizationParams are applied first)", () => {
			const out = applyOfflineAccessToAuthorizationUrl(authorizeUrl(GOOGLE, { prompt: "select_account" }), undefined)
			expect(out.searchParams.get("prompt")).toBe("select_account")
			expect(out.searchParams.get("access_type")).toBe("offline")
		})

		it("leaves unrelated hosts, including lookalikes, untouched", () => {
			for (const base of [GENERIC, "https://accounts.google.com.evil.test/o/oauth2/v2/auth"]) {
				const out = applyOfflineAccessToAuthorizationUrl(authorizeUrl(base), undefined)
				expect(out.searchParams.has("access_type")).toBe(false)
				expect(out.searchParams.has("prompt")).toBe(false)
			}
		})
	})

	describe("advertised offline_access scope (stage 1)", () => {
		it("appends offline_access when the authorization server advertises it", () => {
			const out = applyOfflineAccessToAuthorizationUrl(
				authorizeUrl(GENERIC, { scope: "mcp:tools" }),
				discovery(["mcp:tools", "offline_access"]),
			)
			expect(out.searchParams.get("scope")).toBe("mcp:tools offline_access")
		})

		it("does not duplicate a scope that is already requested", () => {
			const out = applyOfflineAccessToAuthorizationUrl(
				authorizeUrl(GENERIC, { scope: "mcp:tools offline_access" }),
				discovery(["offline_access"]),
			)
			expect(out.searchParams.get("scope")).toBe("mcp:tools offline_access")
		})

		it("does nothing when the server does not advertise it (Google lists only openid/email/profile)", () => {
			const out = applyOfflineAccessToAuthorizationUrl(
				authorizeUrl(GENERIC, { scope: "mcp:tools" }),
				discovery(["openid", "email", "profile"]),
			)
			expect(out.searchParams.get("scope")).toBe("mcp:tools")
		})

		it("never invents a scope parameter when none is requested", () => {
			const out = applyOfflineAccessToAuthorizationUrl(authorizeUrl(GENERIC), discovery(["offline_access"]))
			expect(out.searchParams.has("scope")).toBe(false)
		})

		it("combines with the vendor table without adding offline_access for a server that does not advertise it", () => {
			const out = applyOfflineAccessToAuthorizationUrl(
				authorizeUrl(GOOGLE, { scope: "openid" }),
				discovery(["openid", "email", "profile"]),
			)
			expect(out.searchParams.get("scope")).toBe("openid")
			expect(out.searchParams.get("access_type")).toBe("offline")
		})
	})

	describe("hostile or missing metadata", () => {
		it.each([
			["no discovery state", undefined],
			[
				"no authorization server metadata",
				{ authorizationServerUrl: "https://auth.example.test" } as unknown as Discovery,
			],
			["numeric scopes_supported", discovery(42)],
			["string scopes_supported", discovery("offline_access")],
			["object scopes_supported", discovery({ offline_access: true })],
			["null scopes_supported", discovery(null)],
		])("does not throw or change the scope for %s", (_label, state) => {
			const out = applyOfflineAccessToAuthorizationUrl(authorizeUrl(GENERIC, { scope: "mcp:tools" }), state)
			expect(out.searchParams.get("scope")).toBe("mcp:tools")
		})
	})

	it("returns a new URL and leaves its input unmodified", () => {
		const input = authorizeUrl(GOOGLE, { scope: "openid" })
		const before = input.toString()
		const out = applyOfflineAccessToAuthorizationUrl(input, undefined)
		expect(input.toString()).toBe(before)
		expect(out).not.toBe(input)
	})
})
