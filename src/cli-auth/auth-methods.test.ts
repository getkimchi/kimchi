import { describe, expect, it, vi } from "vitest"
import { authMethodRegion, isSsoAuthMethodId } from "./auth-methods.js"

vi.mock("../config.js", () => ({
	resolveEndpoints: () => ({ region: "eu" }),
}))

describe("isSsoAuthMethodId", () => {
	it("accepts the base id and its region pins", () => {
		expect(isSsoAuthMethodId("kimchi-sso")).toBe(true)
		expect(isSsoAuthMethodId("kimchi-sso-us")).toBe(true)
		expect(isSsoAuthMethodId("kimchi-sso-eu")).toBe(true)
	})

	it("rejects agent auth and unknown ids", () => {
		expect(isSsoAuthMethodId("kimchi-agent")).toBe(false)
		expect(isSsoAuthMethodId("kimchi-agent-us")).toBe(false)
		expect(isSsoAuthMethodId("kimchi-ssous")).toBe(false)
		expect(isSsoAuthMethodId("")).toBe(false)
	})
})

describe("authMethodRegion", () => {
	it("resolves base ids to the configured region", () => {
		expect(authMethodRegion("kimchi-agent")).toBe("eu")
		expect(authMethodRegion("kimchi-sso")).toBe("eu")
	})

	it("resolves region-pinned ids to their own region", () => {
		expect(authMethodRegion("kimchi-agent-us")).toBe("us")
		expect(authMethodRegion("kimchi-sso-eu")).toBe("eu")
	})

	it("returns undefined for unknown or invalid ids", () => {
		expect(authMethodRegion("kimchi-terminal")).toBeUndefined()
		expect(authMethodRegion("kimchi-sso-mars")).toBeUndefined()
		expect(authMethodRegion("kimchi-agent-us-extra")).toBeUndefined()
	})
})
