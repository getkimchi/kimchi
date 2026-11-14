import { describe, expect, it } from "vitest"
import { isBase64ShadowDrop, isGenericNonSecretValue, redactText } from "./redactor.js"

describe("rule-2 follow-up: long-run base64 witness", () => {
	// Adjudicated: double-'=' evidence sweeps ~0 on the corpus; the FP spans sit
	// mid-run with alnum neighbors both sides. A ≥16-char run before the span can
	// only be blob payload — assignment/URL/prose framings expose a delimiter.
	// GCP_API_KEY stands in for any shadow-suppressed entity — the predicate
	// checks membership + geometry, not the span's shape.
	it("drops mid-run fragments even with alnum end-neighbor", () => {
		const blob = `${"a".repeat(40)}key[REDACTED-GCP_API_KEY]5pO4n${"B".repeat(10)}`
		expect(isBase64ShadowDrop("GCP_API_KEY", blob, 40, 40 + 17)).toBe(true)
	})

	it("keeps assignment- and path-adjacent spans (delimiter resets the run)", () => {
		const key = "key" + "aB3dE6gH9jK2mN"
		expect(isBase64ShadowDrop("GCP_API_KEY", `api_key=${key}`, 8, 8 + 17)).toBe(false)
		expect(isBase64ShadowDrop("GCP_API_KEY", `/v1/${key}`, 4, 4 + 17)).toBe(false)
		expect(isBase64ShadowDrop("GCP_API_KEY", `token: ${key}`, 7, 7 + 17)).toBe(false)
	})
})

describe("rule-1: GENERIC_SECRET value guards", () => {
	it("rejects placeholders, paths, expansions, and digit-free identifiers", () => {
		for (const v of [
			"<your_access_token>",
			"$CI_BUILDS_DIR/gcp_creds.json",
			"/var/secrets/db-pass",
			"options.bearerToken",
			"oauthRefreshToken,",
			"refreshTokenValue",
		]) {
			expect(isGenericNonSecretValue(v), v).toBe(true)
		}
	})

	it("keeps real secret shapes: slash-bearing base64, digit-carrying, lowercase words", () => {
		const slashB64 = ["2saUh3fDMymtbS9NHzqmlNVP0jxXXX", "NSJE8SXWb/", "uO"].join("")
		const digits = "sTr0ng" + "P4ss" + "w0rd" + "!9z"
		expect(isGenericNonSecretValue(slashB64)).toBe(false)
		expect(isGenericNonSecretValue(digits)).toBe(false)
		expect(isGenericNonSecretValue("mysecretpassword")).toBe(false)
	})

	it("redactText: rejected values pass through, keep-class values redact", async () => {
		const unguardPath = "/var/secrets/db-pa" + "ss-unguard"
		const out1 = await redactText(`token: ${unguardPath}`)
		expect(out1).toContain(unguardPath)
		const out2 = await redactText("via token: " + "oauthRefreshToken,")
		expect(out2).toContain("oauthRefreshToken,")
		const pw = "sTr0ng" + "P4ss" + "w0rd" + "!9z"
		const out3 = await redactText(`token: ${pw}`)
		expect(out3).toContain("[REDACTED-GENERIC_SECRET]")
		const pw2 = "mysecretpassword"
		const out4 = await redactText(`password: ${pw2}`)
		expect(out4).toContain("[REDACTED-GENERIC_SECRET]")
	})
})
