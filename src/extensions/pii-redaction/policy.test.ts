import { describe, expect, it } from "vitest"
import { getDefaultExcludedEntities, REDACTION_CATEGORIES } from "./entity-tiers.js"
import { parseLocalPolicy, parseManagedPolicy, type RedactionPolicy, resolveRedactionPolicy } from "./policy.js"

const ACME_PATTERN = "(emp[-_ ]?id\\s*[:=]\\s*)(E\\d{6})"

describe("resolveRedactionPolicy — defaults", () => {
	it("no policy anywhere reproduces the tier defaults exactly", () => {
		const resolved = resolveRedactionPolicy()
		expect(resolved.engineExclusions).toEqual(getDefaultExcludedEntities())
		expect(resolved.disabledEntities.size).toBe(0)
		expect(resolved.customPatterns).toEqual([])
		// GUID is not part of the configurable universe.
		expect(resolved.categories.has("GUID")).toBe(false)
	})

	it("the signature is deterministic and state-sensitive", () => {
		expect(resolveRedactionPolicy().signature).toBe(resolveRedactionPolicy().signature)
		const off = resolveRedactionPolicy(undefined, { entities: { EMAIL_ADDRESS: "off" } })
		expect(off.signature).not.toBe(resolveRedactionPolicy().signature)
	})
})

describe("resolveRedactionPolicy — entity and category states", () => {
	it("entity OFF excludes at engine level and suspends custom coverage", () => {
		const resolved = resolveRedactionPolicy(undefined, { entities: { EMAIL_ADDRESS: "off" } })
		expect(resolved.engineExclusions).toContain("EMAIL_ADDRESS")
		expect(resolved.disabledEntities.has("EMAIL_ADDRESS")).toBe(true)
	})

	it("category OFF applies to every member (secrets: engine markers and anchored customs)", () => {
		const resolved = resolveRedactionPolicy(undefined, { categories: { secrets: "off" } })
		for (const name of ["GITHUB_TOKEN", "CASTAI_API_KEY", "GENERIC_SECRET", "SECRET_FIELD", "OPENAI_API_KEY"]) {
			expect(resolved.engineExclusions, name).toContain(name)
			expect(resolved.disabledEntities.has(name), name).toBe(true)
		}
		// Other categories untouched.
		expect(resolved.engineExclusions).not.toContain("IP_ADDRESS")
	})

	it("entity ON re-enables a bare-shape engine detector (PHONE_NUMBER)", () => {
		const resolved = resolveRedactionPolicy(undefined, { entities: { PHONE_NUMBER: "on" } })
		expect(resolved.engineExclusions).not.toContain("PHONE_NUMBER")
	})

	it("entity ON never enables an anchor-required entity's bare engine detector", () => {
		const resolved = resolveRedactionPolicy(undefined, { entities: { AWS_SECRET_KEY: "on" } })
		expect(resolved.engineExclusions).toContain("AWS_SECRET_KEY")
		expect(resolved.disabledEntities.has("AWS_SECRET_KEY")).toBe(false)
	})

	it("entity ON against a category OFF re-enables just that entity", () => {
		const resolved = resolveRedactionPolicy(undefined, {
			categories: { secrets: "off" },
			entities: { CASTAI_API_KEY: "on" },
		})
		expect(resolved.disabledEntities.has("CASTAI_API_KEY")).toBe(false)
		expect(resolved.disabledEntities.has("OPENAI_API_KEY")).toBe(true)
	})
})

describe("resolveRedactionPolicy — precedence (managed > local; entity > category)", () => {
	const managed: RedactionPolicy = { categories: { network: "off" }, entities: { IP_ADDRESS: "on" } }
	const local: RedactionPolicy = { categories: { network: "on" }, entities: { IP_ADDRESS: "off", MAC_ADDRESS: "on" } }

	it("managed entity beats managed category; managed category beats local entity/category", () => {
		const resolved = resolveRedactionPolicy(managed, local)
		// managed.entities.IP_ADDRESS=on wins over everything local.
		expect(resolved.engineExclusions).not.toContain("IP_ADDRESS")
		// managed.categories.network=off wins over local.entities.MAC_ADDRESS=on.
		expect(resolved.engineExclusions).toContain("MAC_ADDRESS")
	})

	it("local policy fills keys the managed policy left unset", () => {
		const resolved = resolveRedactionPolicy({ categories: { network: "off" } }, { entities: { EMAIL_ADDRESS: "off" } })
		expect(resolved.engineExclusions).toContain("IP_ADDRESS")
		expect(resolved.engineExclusions).toContain("EMAIL_ADDRESS")
	})
})

describe("resolveRedactionPolicy — legacy excludedEntities path", () => {
	it("replaces the engine exclusions wholesale (pre-policy meaning)", () => {
		const resolved = resolveRedactionPolicy(undefined, { legacyExcluded: ["GUID"] })
		expect(resolved.engineExclusions).toEqual(["GUID"])
		expect(resolved.disabledEntities).toEqual(new Set(["GUID"]))
	})

	it("managed states still apply per key on top of the legacy result", () => {
		const resolved = resolveRedactionPolicy(
			{ entities: { LOCAL_PATH: "off", US_SSN: "on" } },
			{ legacyExcluded: [...getDefaultExcludedEntities(), "LOCAL_PATH"] },
		)
		// OFF adds LOCAL_PATH back (already listed); ON for a bare-shape entity
		// drops US_SSN from the list.
		expect(resolved.engineExclusions).toContain("LOCAL_PATH")
		expect(resolved.engineExclusions).not.toContain("US_SSN")
	})

	it("an anchor-required entity ON cannot un-exclude its bare detector even against a legacy list", () => {
		// The legacy list excluded URL at the engine. A managed entities.URL=on
		// must keep it excluded — anchor_required ON means "anchored patterns
		// run", never the bare shape; only the legacy list itself re-enables it.
		const anchoredOn = resolveRedactionPolicy(
			{ entities: { URL: "on", GENERIC_SECRET: "off" } },
			{ legacyExcluded: ["GUID", "URL", "GENERIC_SECRET"] },
		)
		expect(anchoredOn.engineExclusions).toContain("URL")
		expect(anchoredOn.disabledEntities.has("URL")).toBe(false)
		// OFF removes GENERIC_SECRET's anchored coverage on top of the legacy list.
		expect(anchoredOn.disabledEntities.has("GENERIC_SECRET")).toBe(true)
	})
})

describe("resolveRedactionPolicy — custom entities", () => {
	const custom = {
		name: "ACME_EMPLOYEE_ID",
		category: "identity_documents",
		pattern: ACME_PATTERN,
		flags: "i",
		secretGroup: 2,
	} as const

	it("compiles with a global flag and defaults to on", () => {
		const resolved = resolveRedactionPolicy(undefined, { customEntities: [custom] })
		expect(resolved.customPatterns).toHaveLength(1)
		const compiled = resolved.customPatterns[0]
		expect(compiled.name).toBe("ACME_EMPLOYEE_ID")
		expect(compiled.category).toBe("identity_documents")
		expect(compiled.regex.flags).toContain("g")
		expect(compiled.regex.flags).toContain("i")
		expect(compiled.secretGroup).toBe(2)
		expect(resolved.categories.get("ACME_EMPLOYEE_ID")).toBe("identity_documents")
		// Not an engine entity — never in engineExclusions.
		expect(resolved.engineExclusions).not.toContain("ACME_EMPLOYEE_ID")
	})

	it("an explicit OFF skips compilation; category OFF skips it too", () => {
		const off = resolveRedactionPolicy(undefined, {
			customEntities: [custom],
			entities: { ACME_EMPLOYEE_ID: "off" },
		})
		expect(off.customPatterns).toEqual([])
		expect(off.disabledEntities.has("ACME_EMPLOYEE_ID")).toBe(true)

		const catOff = resolveRedactionPolicy(undefined, {
			customEntities: [custom],
			categories: { identity_documents: "off" },
		})
		expect(catOff.customPatterns).toEqual([])
	})

	it("a managed definition wins over a local one with the same name", () => {
		const resolved = resolveRedactionPolicy(
			{ customEntities: [{ ...custom, pattern: "(mgmt_)(M\\d{4})" }] },
			{ customEntities: [custom] },
		)
		expect(resolved.customPatterns).toHaveLength(1)
		expect(resolved.customPatterns[0].regex.source).toContain("mgmt_")
	})
})

describe("parseLocalPolicy — strict validation (fail-visible)", () => {
	it("unknown category names throw", () => {
		expect(() => parseLocalPolicy({ categories: { nope: "off" } })).toThrow(/unknown category/)
	})

	it("unknown entity names throw", () => {
		expect(() => parseLocalPolicy({ entities: { NOPE: "off" } })).toThrow(/unknown entity/)
	})

	it("GUID is not configurable", () => {
		expect(() => parseLocalPolicy({ entities: { GUID: "on" } })).toThrow(/not configurable/)
	})

	it("entity states must be on/off", () => {
		expect(() => parseLocalPolicy({ entities: { EMAIL_ADDRESS: "maybe" } })).toThrow(/"on" or "off"/)
	})

	it("custom entity names colliding with built-ins throw", () => {
		expect(() =>
			parseLocalPolicy({
				customEntities: [{ name: "EMAIL_ADDRESS", category: "emails", pattern: "x{4}" }],
			}),
		).toThrow(/collides/)
	})

	it("catastrophic-backtracking shapes throw (nested quantifier AND quantified alternation)", () => {
		for (const pattern of ["(a+)+", "(\\d{2,})*", "(a|a)*b", "(a|aa)+c", "(ABC|DEF){2,4}"]) {
			expect(() =>
				parseLocalPolicy({ customEntities: [{ name: "ACME_X", category: "secrets", pattern }] }),
			).toThrow(/ReDoS/)
		}
	})

	it("safe alternation in an unquantified group passes", () => {
		const policy = parseLocalPolicy({
			customEntities: [{ name: "ACME_X", category: "secrets", pattern: "(?:emp|hr)[-_ ]?id[:=][A-Z0-9]{6}" }],
		})
		expect(policy.customEntities?.[0].name).toBe("ACME_X")
	})

	it("managed parse drops catastrophic patterns too", () => {
		let dropped: string[] = []
		parseManagedPolicy(
			{ customEntities: [{ name: "ACME_X", category: "secrets", pattern: "(a|a)*b" }] },
			(reasons) => {
				dropped = reasons
			},
		)
		expect(dropped.join(" ")).toMatch(/ReDoS/)
	})

	it("oversized patterns and bad flags throw", () => {
		const long = `${"a".repeat(513)}`
		expect(() =>
			parseLocalPolicy({ customEntities: [{ name: "ACME_X", category: "secrets", pattern: long }] }),
		).toThrow(/512/)
		expect(() =>
			parseLocalPolicy({
				customEntities: [{ name: "ACME_X", category: "secrets", pattern: "x{4}", flags: "y" }],
			}),
		).toThrow(/flags/)
	})

	it("non-object custom entries throw the fail-visible error, not a TypeError", () => {
		expect(() => parseLocalPolicy({ customEntities: [null] })).toThrow(/is not an object/)
		expect(() => parseLocalPolicy({ customEntities: ["junk"] })).toThrow(/is not an object/)
	})

	it("non-compiling patterns throw with the engine's message", () => {
		expect(() =>
			parseLocalPolicy({ customEntities: [{ name: "ACME_X", category: "secrets", pattern: "(unclosed" }] }),
		).toThrow(/does not compile/)
	})

	it("entity keys may reference custom names declared in the same block", () => {
		const policy = parseLocalPolicy({
			customEntities: [{ name: "ACME_ID", category: "identity_documents", pattern: "E\\d{6}" }],
			entities: { ACME_ID: "off" },
		})
		expect(policy.entities).toEqual({ ACME_ID: "off" })
	})

	it("every declared category key parses", () => {
		for (const key of REDACTION_CATEGORIES) {
			expect(parseLocalPolicy({ categories: { [key]: "off" } }).categories?.[key]).toBe("off")
		}
	})
})

describe("parseManagedPolicy — tolerant validation (fail-open with one log)", () => {
	it("accepts enum-style wire values", () => {
		const policy = parseManagedPolicy({
			categories: { network: "KIMCHI_REDACTION_STATE_OFF" },
			entities: { PHONE_NUMBER: "KIMCHI_REDACTION_STATE_ON" },
		})
		expect(policy?.categories).toEqual({ network: "off" })
		expect(policy?.entities).toEqual({ PHONE_NUMBER: "on" })
	})

	it("drops unknown keys and keeps the valid rest, collecting reasons", () => {
		let dropped: string[] = []
		const policy = parseManagedPolicy(
			{
				categories: { network: "off", future_category: "off" },
				entities: { EMAIL_ADDRESS: "off", FUTURE_ENTITY: "off" },
			},
			(reasons) => {
				dropped = reasons
			},
		)
		expect(policy?.categories).toEqual({ network: "off" })
		expect(policy?.entities).toEqual({ EMAIL_ADDRESS: "off" })
		expect(dropped.join(" ")).toMatch(/future_category/)
		expect(dropped.join(" ")).toMatch(/FUTURE_ENTITY/)
	})

	it("drops UNSPECIFIED and invalid custom entities", () => {
		const policy = parseManagedPolicy({
			categories: { network: "KIMCHI_REDACTION_STATE_UNSPECIFIED" },
			customEntities: [{ name: "EMAIL_ADDRESS", category: "emails", pattern: "x" }],
		})
		expect(policy).toBeUndefined()
	})

	it("non-object input parses as absent, never throws", () => {
		expect(parseManagedPolicy(null)).toBeUndefined()
		expect(parseManagedPolicy("junk")).toBeUndefined()
		expect(parseManagedPolicy(42)).toBeUndefined()
	})
})
