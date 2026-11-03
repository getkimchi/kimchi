import { describe, expect, it } from "vitest"
import { type BillingSource, sameBillingSource } from "./billing-source.js"

const source = (apiUrl: string): BillingSource => ({
	apiUrl,
	gatewayUrl: "https://llm.kimchi.dev/openai/v1/chat/completions",
	credentialHash: "a".repeat(64),
})

describe("sameBillingSource", () => {
	it("matches a source captured with the legacy console platform API base", () => {
		// Before platformApiUrl moved to the region's API origin, billing sources
		// captured webAppUrl + "/api". Those stored sources must keep matching a
		// freshly captured base — in both the upgrade and rollback direction —
		// or cost-sync marks them "account-changed" and the 32-day billing window
		// never closes.
		expect(sameBillingSource(source("https://app.kimchi.dev/api"), source("https://api.cast.ai"))).toBe(true)
		expect(sameBillingSource(source("https://app.eu.kimchi.dev/api"), source("https://api.eu.cast.ai"))).toBe(true)
		expect(sameBillingSource(source("https://api.cast.ai"), source("https://app.kimchi.dev/api"))).toBe(true)
	})

	it("does not conflate regions or other endpoints", () => {
		expect(sameBillingSource(source("https://app.kimchi.dev/api"), source("https://api.eu.cast.ai"))).toBe(false)
		expect(sameBillingSource(source("https://app.kimchi.dev/api"), source("https://api.example"))).toBe(false)
		expect(sameBillingSource(source("https://api.cast.ai"), source("https://api.cast.ai"))).toBe(true)
	})
})
