import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	getDefaultExcludedEntities,
	getEntityCategory,
	getEntityDefaultOn,
	getEntityTier,
	isKnownEntity,
	isRedactionCategory,
	listRedactionCatalog,
	listRegisteredEntities,
	REDACTION_CATEGORIES,
} from "./entity-tiers.js"
import { applyCustomPatterns, CUSTOM_PATTERN_NAMES, createRedactionEngine, detectAndCompose } from "./redactor.js"

// Fixture values are assembled at runtime — see redactor.test.ts for why
// (this file is itself edited by a redacting agent pipeline).
const corpusParts = [
	["Contact jane.doe", "example.com"].join("@"),
	`CC: ${["4532", "0151", "1283", "0366"].join("")}`,
	`IBAN: ${["DE89", "3704", "0044", "0532", "0130", "00"].join(" ")}`,
	`Bearer ${"ey" + "JhbGciOiJIUzI1Ni" + "J9.test123" + "-AbCdEfGh"}`,
	"AKIA" + "IOSFODNN7EXAMPLE",
	`token ghp_${"n1".repeat(18)} here`,
	`api key ${["sk-", "liveTe".repeat(4), "9z"].join("")}`,
	`key ${["castai_v1_", "Ab3".repeat(7), "x"].join("")}`,
	`oauth ${["ya29", ".", "a0AfH6SMBx".repeat(2)].join("")}`,
	`wallet ${["0x", "a1b2c3d4e5".repeat(4)].join("")}`,
	`commit ${"a89b3cd4".repeat(5)}`,
	`created ${[["2026", "11", "02"].join("-"), "T", ["21", "27", "58"].join(":"), ".323Z"].join("")}`,
	`call ${["+1", "(415)", "555", "0132"].join(" ")}`,
	`SSN ${["123", "45", "6789"].join("-")}`,
	`bind ${["203", "0", "113", "7"].join(".")}`,
	`uuid 019f36c2-1b53-71ed-afc8-faded478f42a`,
	["open ", "https", "://", "developer.mozilla.org", "/docs"].join(""),
	["https", "://", "api.example", ".com", "/x", "?", "token", "=", "abc123XYZ", "890123"].join(""),
	["db ", "postgresql", "://", "svc", ":", "p4ss", "w0rd", "@", "db.internal", "/app"].join(""),
	["DefaultEndpointsProtocol=https;AccountName=store;AccountKey=", "K7xQ".repeat(11), "=="].join(""),
	`Authorization: Basic ${["dXNlcjpwYXNzd29yZA", "=="].join("")}`,
	`aws_secret_access_key = ${["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLE", "KEY"].join("")}`,
	["mac ", "aa", ":bb", ":cc", ":dd", ":ee", ":ff"].join(""),
	`Config at ${["", "Users", "jane", ".ssh", "id_rsa"].join("/")}`,
	`pipeline 5570509412 completed`,
]
const corpus = corpusParts.join("\n")

const MARKER = /\[REDACTED-([A-Z0-9_]+)\]/g

function markerTypesOf(text: string): Set<string> {
	return new Set([...text.matchAll(MARKER)].map((m) => m[1] as string))
}

describe("entity tier registry", () => {
	it("default exclusions cover bare shapes (minus keep-list) and anchor-required, not checksum/anchored", () => {
		const excluded = new Set(getDefaultExcludedEntities())
		expect(excluded.has("GUID")).toBe(true) // structural identifiers
		expect(excluded.has("DATE_TIME")).toBe(true)
		expect(excluded.has("US_SSN")).toBe(true)
		expect(excluded.has("CRYPTO")).toBe(true)
		expect(excluded.has("AWS_SECRET_KEY")).toBe(true)
		expect(excluded.has("URL")).toBe(true)
		// Kept on:
		expect(excluded.has("CREDIT_CARD")).toBe(false)
		expect(excluded.has("IBAN_CODE")).toBe(false)
		expect(excluded.has("EMAIL_ADDRESS")).toBe(false)
		expect(excluded.has("IP_ADDRESS")).toBe(false)
		expect(excluded.has("GITHUB_TOKEN")).toBe(false)
	})

	it("every emitted entity type is registered (engine-vocabulary drift guard)", async () => {
		const engine = createRedactionEngine([])
		const composed = await detectAndCompose(corpus, engine, new Set())
		const unknown = [...markerTypesOf(composed)].filter((t) => !isKnownEntity(t))
		// A bulkhead upgrade that introduces a new entity fails here and must
		// be classified in entity-tiers.ts — never silently shipped.
		expect(unknown).toEqual([])
	})

	it("registry covers the engine's full detector inventory (static drift guard)", () => {
		// Marker emission only guards entities the fixture corpus triggers.
		// This guard diffs the registry against the engine's actual detector
		// inventory, extracted from the bundled @bulkhead-ai/core dist — the
		// same source the runtime loads.
		const dist = readFileSync(
			new URL("../../../node_modules/@bulkhead-ai/core/dist/index.js", import.meta.url),
			"utf-8",
		)
		const inventory = new Set([...dist.matchAll(/secretType:\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]))
		expect(inventory.size).toBeGreaterThan(100) // extraction still works
		const unregistered = [...inventory].filter((name) => !isKnownEntity(name))
		expect(unregistered).toEqual([])
	})

	it("with default exclusions, only checksum/anchored tiers emit at engine level", async () => {
		const engine = createRedactionEngine(getDefaultExcludedEntities())
		const composed = await detectAndCompose(corpus, engine, new Set(getDefaultExcludedEntities()))
		// Engine-level assertion only: the anchor_required tier means
		// "excluded at engine, re-added anchored by custom patterns" — after
		// applyCustomPatterns those markers legitimately reappear by design,
		// so they must not be counted as leaks here.
		const leaked = [...markerTypesOf(composed)].filter((t) => {
			const tier = getEntityTier(t)
			if (tier !== "bare_shape" && tier !== "anchor_required") return false
			// BARE_SHAPE_KEPT names are shape-based exceptions deliberately
			// left on at engine level (dotted quads, MAC addresses, and email
			// shapes with their own non-identifying filter upstream do not
			// collide with common text).
			return !(t === "IP_ADDRESS" || t === "MAC_ADDRESS" || t === "EMAIL_ADDRESS")
		})
		expect(leaked).toEqual([])
		// Custom markers (post-pass) are all registered — anchored re-additions
		// wear their entity's name by design.
		const afterCustom = applyCustomPatterns(composed, new Set())
		for (const t of markerTypesOf(afterCustom)) {
			expect(isKnownEntity(t)).toBe(true)
		}
	})

	it("custom-pattern markers are all registered kimchi-owned types", async () => {
		const afterCustom = applyCustomPatterns(corpus, new Set())
		for (const t of markerTypesOf(afterCustom)) {
			expect(isKnownEntity(t)).toBe(true)
		}
	})

	it("every custom-pattern name is a registered entity (structural sync)", () => {
		// Corpus-driven checks only cover patterns the fixtures trigger; this
		// enumerates the pattern table itself so a new pattern without a
		// registry entry fails here — an unregistered name could never appear
		// in redaction.excludedEntities, silently making it un-excludable.
		for (const name of CUSTOM_PATTERN_NAMES) {
			expect(isKnownEntity(name), `custom pattern "${name}" is not registered in entity-tiers`).toBe(true)
		}
	})

	it("every registered entity except GUID and UK_POSTCODE has exactly one category; every category member is registered", () => {
		const catalog = listRedactionCatalog()
		expect(catalog.length).toBeGreaterThan(100)
		// Reverse direction too: a future tier-array addition forgotten in
		// CATEGORY_GROUPS must fail here — it would silently become
		// non-configurable (local toggle throws, telemetry attributes "custom").
		// GUID and UK_POSTCODE are the only deliberate uncategorized names.
		const cataloged = new Set(catalog.map((e) => e.entity))
		for (const name of listRegisteredEntities()) {
			if (name === "GUID" || name === "UK_POSTCODE") continue
			expect(cataloged.has(name), `${name} is registered but has no category entry`).toBe(true)
		}
		// Sorted by entity name (stable wire for the console), no duplicates.
		expect(catalog.map((e) => e.entity)).toEqual([...catalog.map((e) => e.entity)].sort((a, b) => a.localeCompare(b)))
		for (let i = 1; i < catalog.length; i++) {
			expect(catalog[i].entity).not.toBe(catalog[i - 1].entity)
		}
		// Members are registered, tiers match the registry, categories known.
		for (const entry of catalog) {
			expect(isKnownEntity(entry.entity), entry.entity).toBe(true)
			expect(getEntityTier(entry.entity), entry.entity).toBe(entry.tier)
			expect(isRedactionCategory(entry.category), entry.entity).toBe(true)
			expect(getEntityCategory(entry.entity)).toBe(entry.category)
			expect(getEntityDefaultOn(entry.entity)).toBe(entry.defaultOn)
		}
		// GUID is never configurable: not in the catalog, no category.
		expect(catalog.some((e) => e.entity === "GUID")).toBe(false)
		expect(getEntityCategory("GUID")).toBeUndefined()
		expect(getEntityDefaultOn("GUID")).toBe(false)
		// UK_POSTCODE is dropped from the configurable surface: shape-only
		// postal code, too low-value as a redaction choice to offer a toggle.
		expect(catalog.some((e) => e.entity === "UK_POSTCODE")).toBe(false)
		expect(getEntityCategory("UK_POSTCODE")).toBeUndefined()
		expect(getEntityDefaultOn("UK_POSTCODE")).toBe(false)
		// Nine categories, all populated.
		expect(REDACTION_CATEGORIES).toHaveLength(9)
		for (const category of REDACTION_CATEGORIES) {
			expect(catalog.filter((e) => e.category === category).length, category).toBeGreaterThan(0)
		}
	})

	it("effective defaults match today's redaction behavior for the edge members", () => {
		// Default-on: checksum, anchored, engine-kept bare shapes, anchored customs.
		for (const name of [
			"CREDIT_CARD",
			"IBAN_CODE",
			"EMAIL_ADDRESS",
			"IP_ADDRESS",
			"MAC_ADDRESS",
			"GITHUB_TOKEN",
			"AWS_SECRET_KEY", // anchored custom only — covered by default
			"GENERIC_SECRET",
			"TELEGRAM_BOT_TOKEN",
			"OKTA_TOKEN",
			"SECRET_FIELD",
			"LOCAL_PATH",
			"URL_WITH_CREDENTIALS",
			"REDIS_URL_WITH_PASSWORD",
		]) {
			expect(getEntityDefaultOn(name), name).toBe(true)
		}
		// Default-off: bare shapes, inert anchor-required entities.
		for (const name of [
			"PHONE_NUMBER",
			"DATE_TIME",
			"US_SSN",
			"CRYPTO",
			"PERSON",
			"LOCATION",
			"ORGANIZATION",
			"AIRTABLE_KEY", // demoted: measured ~3% precision on transcripts; opt-in choice
			"URL",
			"ELASTICSEARCH_URL",
			"MONGODB_SRV",
			"ABA_ROUTING_NUMBER",
		]) {
			expect(getEntityDefaultOn(name), name).toBe(false)
		}
		// Category spot checks across the nine buckets.
		expect(getEntityCategory("EMAIL_ADDRESS")).toBe("emails")
		expect(getEntityCategory("PHONE_NUMBER")).toBe("phones")
		expect(getEntityCategory("IP_ADDRESS")).toBe("network")
		expect(getEntityCategory("LOCAL_PATH")).toBe("local_paths")
		expect(getEntityCategory("CREDIT_CARD")).toBe("financial")
		expect(getEntityCategory("US_SSN")).toBe("identity_documents")
		expect(getEntityCategory("US_NPI")).toBe("identity_documents")
		expect(getEntityCategory("PERSON")).toBe("personal_details")
		expect(getEntityCategory("URL_WITH_CREDENTIALS")).toBe("credentialed_urls")
		expect(getEntityCategory("GITHUB_TOKEN")).toBe("secrets")
		expect(getEntityCategory("AZURE_CONNECTION_STRING")).toBe("credentialed_urls")
		// Dropped from the configurable surface — see the unassigned-names block.
		expect(getEntityCategory("UK_POSTCODE")).toBeUndefined()
	})

	it("covers every entity the bundled engine can emit today", async () => {
		// The registry was classified against the full 208-entity vocabulary
		// extracted from @bulkhead-ai/core's bundle; this sanity check keeps
		// the big-ticket members present so an accidental deletion surfaces.
		for (const entity of [
			"AZURE_STORAGE_KEY",
			"DATABASE_CONNECTION_STRING",
			"ELASTICSEARCH_URL",
			"FIREBASE_URL",
			"MONGODB_SRV",
			"BASIC_AUTH",
			"DOCKER_REGISTRY_AUTH",
			"GENERIC_SECRET",
			"LOCATION",
			"PERSON",
			"ORGANIZATION",
			"TELEGRAM_BOT_TOKEN",
			"OKTA_TOKEN",
			"SLACK_WEBHOOK",
			"SENTRY_DSN",
			"REDIS_URL_WITH_PASSWORD",
			"STRIPE_KEY",
			"JWT_TOKEN",
			"BEARER_TOKEN",
			"PRIVATE_KEY",
			"MAC_ADDRESS",
			"LOCAL_PATH",
			"CREDENTIAL_FILE",
			"SECRET_FIELD",
			"URL_WITH_CREDENTIALS",
		]) {
			expect(isKnownEntity(entity), entity).toBe(true)
		}
	})

	it("liveState classifies every entity's engine-side disposition", () => {
		const catalog = listRedactionCatalog()
		expect(catalog.length).toBeGreaterThan(200)
		// Every entry carries a valid liveState; alias_of carries its target.
		for (const entry of catalog) {
			expect(["active", "alias_of", "no_matcher"], entry.entity).toContain(entry.liveState)
			if (entry.liveState === "alias_of") expect(entry.aliasOf).toBe("URL_WITH_CREDENTIALS")
			else expect(entry.aliasOf, entry.entity).toBeUndefined()
		}
		// Pinned dispositions — the three meanings "defaultOn: false" used to collapse.
		const byName = new Map(catalog.map((e) => [e.entity, e]))
		// Policy-off, matcher live: flipping on is a meaningful choice.
		expect(byName.get("PHONE_NUMBER")?.liveState).toBe("active")
		expect(byName.get("PERSON")?.liveState).toBe("active")
		// Alias-off: coverage lives in URL_WITH_CREDENTIALS customs.
		for (const name of ["URL", "MONGODB_SRV", "ELASTICSEARCH_URL", "FIREBASE_URL"]) {
			expect(byName.get(name)?.liveState, name).toBe("alias_of")
		}
		// Measured-inert demotions: nothing fires under any policy.
		for (const name of ["CRATES_IO_TOKEN", "NUGET_KEY"]) {
			expect(byName.get(name)?.liveState, name).toBe("no_matcher")
		}
		// Chunk-5 promotions: these now have their own anchored customs.
		expect(byName.get("AZURE_CONNECTION_STRING")?.liveState).toBe("active")
		expect(byName.get("DATABASE_CONNECTION_STRING")?.liveState).toBe("active")
		// Aliases are not actionable through the modern policy path: post-#1699
		// anchor_required ON runs anchored customs, and none exist under the
		// alias names — their toggles are dead, so they stay out of the
		// published catalog alongside no_matcher.
	})

	it("the published generator output contains only actionable rows", async () => {
		// scripts/redaction-catalog.ts publishes liveState === "active" only: dead
		// toggles (no_matcher: nothing fires; alias_of: policy ON cannot activate
		// the bare shape post-#1699 — anchor_required ON runs anchored customs,
		// and none exist under the alias names) are worse than missing rows for
		// policy-UI consumers. The registry keeps those entities (drift test,
		// settings validation); only the published contract drops them.
		const { execFileSync } = await import("node:child_process")
		const { fileURLToPath } = await import("node:url")
		const { join, dirname } = await import("node:path")
		const here = dirname(fileURLToPath(import.meta.url))
		const script = join(here, "..", "..", "..", "scripts", "redaction-catalog.ts")
		const out = execFileSync("bun", [script], { encoding: "utf8" })
		const published = JSON.parse(out) as Array<{ entity: string; liveState: string }>
		expect(published.length).toBe(listRedactionCatalog().filter((e) => e.liveState === "active").length)
		for (const entry of published) {
			expect(entry.liveState, entry.entity).toBe("active")
		}
		const names = published.map((e) => e.entity)
		for (const dead of ["CRATES_IO_TOKEN", "NUGET_KEY", "URL", "MONGODB_SRV", "ELASTICSEARCH_URL", "FIREBASE_URL"]) {
			expect(names, dead).not.toContain(dead)
		}
		// The general credentialed-URL marker that owns alias coverage stays.
		expect(names).toContain("URL_WITH_CREDENTIALS")
	})

	it("every active anchor_required entity has a custom pattern (liveState drift guard)", async () => {
		const { CUSTOM_PATTERN_NAMES } = await import("./redactor.js")
		const customs = new Set(CUSTOM_PATTERN_NAMES)
		for (const entry of listRedactionCatalog()) {
			if (entry.tier !== "anchor_required" || entry.liveState !== "active") continue
			expect(customs.has(entry.entity), entry.entity).toBe(true)
		}
	})
})
