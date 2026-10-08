import { beforeEach, describe, expect, it } from "vitest"
import {
	clearCredentialStale,
	isAuthRejectedMessage,
	isCredentialStale,
	markCredentialStale,
	resetCredentialStalenessForTests,
} from "./credential-staleness.js"

describe("credential-staleness registry", () => {
	beforeEach(() => {
		resetCredentialStalenessForTests()
	})

	it("starts clean", () => {
		expect(isCredentialStale("some-key", "kimchi-dev")).toBe(false)
	})

	it("marks a specific key stale for a provider and reports it", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(true)
	})

	it("scopes staleness to the apiKey: a different key (re-login) is not stale", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(false)
	})

	it("scopes provider-level staleness: a 401 on kimchi-dev poisons the provider even without a key", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(true)
		// Provider mark can't name the key: any key reads stale until cleared.
		expect(isCredentialStale("fresh-key", "kimchi-dev")).toBe(true)
	})

	it("clearCredentialStale wipes both key-level and provider-level marks", () => {
		markCredentialStale("dead-key", "kimchi-dev")
		markCredentialStale(undefined, "kimchi-dev")
		clearCredentialStale("kimchi-dev")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(false)
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
	})

	it("does not leak staleness across providers", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "other-provider")).toBe(false)
	})

	// Kimchi-managed providers share one credential, so their marks and
	// lookups normalize onto the base entry (see the source header).
	it("maps kimchi-managed sub-providers onto the base kimchi-dev entry when marking", () => {
		markCredentialStale(undefined, "kimchi-dev/moonshot")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(true)
		expect(isCredentialStale(undefined, "kimchi-dev/moonshot")).toBe(true)
	})

	it("lookup via a sub-provider sees a mark made via the base", () => {
		markCredentialStale(undefined, "kimchi-dev")
		expect(isCredentialStale(undefined, "kimchi-dev/anthropic")).toBe(true)
	})

	it("maps the experimental provider onto the base kimchi-dev entry", () => {
		markCredentialStale("dead-key", "kimchi-experimental")
		expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(true)
	})

	it("clearing via a kimchi-managed sub-provider clears the base mark", () => {
		markCredentialStale(undefined, "kimchi-dev/moonshot")
		clearCredentialStale("kimchi-dev/moonshot")
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
	})

	it("leaves non-kimchi providers on their own entries", () => {
		markCredentialStale(undefined, "openai")
		expect(isCredentialStale(undefined, "openai")).toBe(true)
		expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
	})
})

describe("isAuthRejectedMessage", () => {
	it.each([
		"Failed to fetch models: 401 Unauthorized",
		"Request failed with status code 401: Unauthorized",
		"invalid api key provided",
		"invalid token",
		"expired token",
		"unauthenticated request",
	])("detects auth-class error text: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(true)
	})

	it.each([
		"Failed to fetch models: 500 Internal Server Error",
		"rate limited, retry in 30s",
		"network down",
		// Substrings must not trigger: prose mentioning "key" is not a rejection.
		"keybinding conflict detected",
	])("does not flag non-auth errors: %s", (message) => {
		expect(isAuthRejectedMessage(message)).toBe(false)
	})
})
