import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { getDefaultExcludedEntities, getEntityTier, isKnownEntity } from "./entity-tiers.js"
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
			// BARE_SHAPE_KEPT names are shape-precise exceptions deliberately
			// left on at engine level (dotted quads and MAC addresses do not
			// collide with common text).
			return !(t === "IP_ADDRESS" || t === "MAC_ADDRESS")
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
})
