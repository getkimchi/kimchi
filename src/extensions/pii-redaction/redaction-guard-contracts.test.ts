import { describe, expect, it } from "vitest"
import { parseLocalPolicy, resolveRedactionPolicy } from "./policy.js"
import { applyCustomPatterns, isBase64ShadowDrop, isGenericNonSecretValue, redactText } from "./redactor.js"

describe("long-run base64 witness", () => {
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

describe("GENERIC_SECRET value guards", () => {
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

describe("modular-crypt hashes keep redacting behind keywords", () => {
	const salts = ["YWFh", "YmJi"].join("")
	const argon2id = ["$argon2id$v=19$m=65536,t=3,p=4$", salts, "$8KxRuPuGX2x5v6y7z8A9B0C1D2E3F4"].join("")
	const argon2i = ["$argon2i$v=19$m=4096,t=3,p=1$", salts, "$pQrStUvWxYz0123456789abcdEFGhI"].join("")
	const argon2d = ["$argon2d$v=19$m=1024,t=2,p=1$", salts, "$MnOpQrStUvWxYz0123456789AbcDeF"].join("")
	const scrypt = ["$s2$N$16384$r$8$p$1$", salts, "$T0U1V2W3X4Y5Z6a7b8c9d0e1f2g3h4"].join("")
	const bcrypt = ["$2b", "$12$", "LJ3m4yPs5t8s9j0k1l2m3n4o5p6q7r8s9t0a"].join("")
	it.each([
		["argon2id", argon2id],
		["argon2i", argon2i],
		["argon2d", argon2d],
		["scrypt", scrypt],
		["bcrypt", bcrypt],
	])("password= %s redacts", async (_label, hash) => {
		const out = await redactText("password=" + hash)
		expect(out).not.toContain(hash)
		expect(out).toContain("[REDACTED-GENERIC_SECRET]")
	})
	it.each(["$VAR", "${HOME:-/tmp}", "$(whoami)", "$[0]"])("shell shape %s still rejected", (shape) => {
		expect(isGenericNonSecretValue(shape)).toBe(true)
	})
})

describe("credential query values may contain brackets", () => {
	it("redacts a lookup token containing [ ]", async () => {
		const token = "ab[cd]ef-" + "x".repeat(20)
		const out = await redactText("?token=" + token + "&next=1")
		expect(out).not.toContain(token)
		expect(out).toContain("&next=1")
	})
	it("never re-consumes an already-redacted marker", async () => {
		const out = await redactText("https://x/?token=[REDACTED-URL_WITH_CREDENTIALS] &next=1".replace(" ", "&"))
		expect(out).not.toContain("[REDACTED-[REDACTED-")
	})
	it("a real secret right after a marker still redacts", async () => {
		const second = "b1c2d3e4f5a6b7c8".repeat(2)
		const out = await redactText(("?token=[REDACTED-URL_WITH_CREDENTIALS] &token=" + second).replace(" ", "&"))
		expect(out).not.toContain(second)
	})
})

describe("Azure SAS ownership: encoded and structured forms", () => {
	const tail = "9J8k7M6n5P4q3R2s1T0u"
	const structured = ["SharedAccessSignature=", "sv=2026-01-01", "&ss=b", "&srt=s", "&sig=", tail].join("")
	const encPiece = ["SharedAccessSignature=sv%3D2026-01-01%26ss%3Db%26sig%3D", "Zz9Yx8Ww7Vv6Uu5Tt4Ss3Rr2Qq1Pp0"].join(
		"",
	)
	it("structured SAS (param continuation) redacts as AZURE_CONNECTION_STRING", async () => {
		const out = await redactText(structured)
		expect(out).not.toContain(tail)
		expect(out).toContain("[REDACTED-AZURE_CONNECTION_STRING]")
	})
	it("URL-encoded SAS redacts as AZURE_CONNECTION_STRING", async () => {
		const out = await redactText(encPiece)
		expect(out).toContain("[REDACTED-AZURE_CONNECTION_STRING]")
		expect(out).not.toContain("Pp0")
	})
	it("a neighboring credential parameter is not eaten into the SAS span", async () => {
		const secretTail = "s3cr3tTail" + "z".repeat(14)
		const inp = ";SharedAccessSignature=" + "sig=" + "x".repeat(20) + "&refresh_token=" + secretTail
		const out = await redactText(inp)
		expect(out).not.toContain(secretTail)
		expect(out).toContain("[REDACTED-URL_WITH_CREDENTIALS]")
	})
	it("policy toggle: AZURE_CONNECTION_STRING owns SAS without the URL custom rescuing it", () => {
		const sasInput = ";SharedAccessSignature=" + "x".repeat(24)
		// URL custom off, Azure on: Azure still claims the SAS value.
		const urlOff = resolveRedactionPolicy(parseLocalPolicy({ entities: { URL_WITH_CREDENTIALS: "off" } }))
		expect(applyCustomPatterns(sasInput, urlOff.disabledEntities)).toContain("[REDACTED-AZURE_CONNECTION_STRING]")
		// Both off: nothing claims it — a stored policy can only weaken SAS
		// coverage by going through Azure, never by accident of the URL rescue.
		const bothOff = resolveRedactionPolicy(
			parseLocalPolicy({ entities: { URL_WITH_CREDENTIALS: "off", AZURE_CONNECTION_STRING: "off" } }),
		)
		expect(applyCustomPatterns(sasInput, bothOff.disabledEntities)).toContain("x".repeat(24))
	})
})

describe("Supabase anon/service JWT realism", () => {
	// Realistic base64url segments joined at the dots so the engine's JWT_TOKEN
	// detector fires — the skip/relabel must discriminate on those claims, and a
	// dot-less blob would pass the tests without exercising them.
	const seg = (c: string, n: number) => c.repeat(n)
	const jwt = () => ["eyJ" + seg("a", 53), seg("h", 80), seg("s", 60)].join(".")
	it("public anon JWT behind the anon label stays untouched", async () => {
		const inp = "NEXT_PUBLIC_SUPABASE_ANON_KEY=" + jwt()
		expect(await redactText(inp)).toBe(inp)
	})
	it("the same JWT behind an unrelated label IS claimed by JWT_TOKEN", async () => {
		const out = await redactText("bearer " + jwt())
		expect(out).not.toContain(jwt())
	})
	it("service-role JWT behind the secret label redacts as SUPABASE_KEY", async () => {
		const out = await redactText("SUPABASE_SERVICE_KEY=" + jwt())
		expect(out).toContain("[REDACTED-SUPABASE_KEY]")
		expect(out).not.toContain(jwt())
	})
})

describe("vault tokens survive keyword proximity (token render mode)", () => {
	it("a vault token right after a keyword is never re-consumed", async () => {
		const out = await redactText("session token: [EMAIL_ADDRESS_1]")
		expect(out).toContain("[EMAIL_ADDRESS_1]")
	})
	it("a vault token as a complete query value survives", async () => {
		const out = await redactText(["?token=", "[EMAIL_ADDRESS_1]", "&next=1"].join(""))
		expect(out).toContain("[EMAIL_ADDRESS_1]")
	})
})

describe("bracket-bearing credentials: value-floor boundaries", () => {
	it("redacts at exactly 8 chars", async () => {
		const token = "ab[cd]ef"
		expect(token).toHaveLength(8)
		const out = await redactText("?token=" + token + "&next=1")
		expect(out).not.toContain(token)
	})
	it("skips below the 8-char floor", async () => {
		const token = "ab[cd]e"
		expect(token).toHaveLength(7)
		const out = await redactText("?token=" + token + "&next=1")
		expect(out).toContain(token)
	})
})

describe("marker-glued secrets never pass through whole", () => {
	it("a secret glued to a trailing redaction marker redacts", async () => {
		const tail = "hunterSecret" + "q".repeat(10)
		const out = await redactText("?token=" + "[REDACTED-URL_WITH_CREDENTIALS]" + tail + "&next=1")
		expect(out).not.toContain(tail)
		expect(out).toContain("[REDACTED-URL_WITH_CREDENTIALS]")
	})
	it("a secret glued after a marker in free text redacts", async () => {
		const tail = "hunterSecret" + "m".repeat(10)
		const out = await redactText("password=[REDACTED-GENERIC_SECRET]" + tail)
		expect(out).not.toContain(tail)
	})
})
