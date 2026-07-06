import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getRedactionConfig, resetRedactionConfigCache } from "./config.js"
import { redactMessages, redactText, resetRedactorEngine } from "./redactor.js"

// ─── Test PII / secret values ────────────────────────────────────────────────
// SSNs use non-obvious numbers (not 000/666/9xx area, valid group & serial)
// Credit cards are Luhn-valid (not reserved test ranges like 4111 1111…)
// Phones use non-reserved area codes
const SAMPLES = {
	email: "Contact john.doe@example.com for details",
	phone: "Call (415) 555-1234 to reach support",
	ssn: "SSN: 489-36-2157",
	creditCard: "CC: 4532015112830366",
	iban: "IBAN: GB82WEST12345698765432",
	bearerToken: "Authorization: Bearer sk-1234567890abcdef1234567890abcdef",
	awsKey: "AWS_KEY=AKIAIOSFODNN7EXAMPLE",
	githubToken: "GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef12",
} as const

// Expected redaction markers (entityType from @bulkhead-ai/core)
const MARKERS = {
	email: "EMAIL_ADDRESS",
	phone: "PHONE_NUMBER",
	ssn: "US_SSN",
	creditCard: "CREDIT_CARD",
	iban: "IBAN_CODE",
	bearerToken: "BEARER_TOKEN",
	awsKey: "AWS_ACCESS_KEY",
	githubToken: "CRYPTO",
} as const

/** Helper: assert that text was redacted (original PII gone, marker present). */
function expectRedacted(result: string, originalPii: string, markerType: string): void {
	expect(result).not.toContain(originalPii)
	expect(result).toContain(`[REDACTED-${markerType}]`)
}

describe("redactText — per-category PII redaction", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts email addresses", async () => {
		const result = await redactText(SAMPLES.email)
		expectRedacted(result, "john.doe@example.com", MARKERS.email)
		expect(result).toContain("Contact")
		expect(result).toContain("for details")
	})

	it("redacts phone numbers", async () => {
		const result = await redactText(SAMPLES.phone)
		expectRedacted(result, "(415) 555-1234", MARKERS.phone)
		expect(result).toContain("Call")
	})

	it("redacts SSNs (Luhn-adjacent format)", async () => {
		const result = await redactText(SAMPLES.ssn)
		expectRedacted(result, "489-36-2157", MARKERS.ssn)
	})

	it("redacts credit cards (Luhn-valid)", async () => {
		const result = await redactText(SAMPLES.creditCard)
		expectRedacted(result, "4532015112830366", MARKERS.creditCard)
	})

	it("redacts IBANs (mod-97 valid)", async () => {
		const result = await redactText(SAMPLES.iban)
		expectRedacted(result, "GB82WEST12345698765432", MARKERS.iban)
	})

	it("redacts Bearer tokens / crypto secrets", async () => {
		const result = await redactText(SAMPLES.bearerToken)
		// The secret part (sk-…) is redacted as CRYPTO
		expect(result).not.toContain("1234567890abcdef1234567890abcdef")
		expect(result).toContain(`[REDACTED-${MARKERS.bearerToken}]`)
	})

	it("redacts AWS access keys", async () => {
		const result = await redactText(SAMPLES.awsKey)
		expectRedacted(result, "AKIAIOSFODNN7EXAMPLE", MARKERS.awsKey)
	})

	it("redacts GitHub tokens", async () => {
		const result = await redactText(SAMPLES.githubToken)
		expect(result).not.toContain("1234567890abcdef1234567890abcdef12")
		expect(result).toContain(`[REDACTED-${MARKERS.githubToken}]`)
	})

	it("returns original text when no PII is present", async () => {
		const clean = "This is a perfectly safe message with no secrets."
		const result = await redactText(clean)
		expect(result).toBe(clean)
	})
})

describe("redactMessages — message structure preservation", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts text blocks in user messages without mutating input", async () => {
		const original = [
			{
				role: "user",
				content: [{ type: "text", text: "My email is john.doe@example.com" }],
			},
		]
		const result = (await redactMessages(original)) as Array<{ content: Array<{ type: string; text: string }> }>

		// Input not mutated
		expect(original[0].content[0].text).toBe("My email is john.doe@example.com")
		// Output redacted
		expect(result[0].content[0].text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result[0].content[0].text).not.toContain("john.doe@example.com")
		// Block type preserved
		expect(result[0].content[0].type).toBe("text")
	})

	it("preserves tool-call JSON blocks (does not redact inside tool arguments)", async () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_001",
						toolName: "send_email",
						input: { to: "john.doe@example.com", body: "Bearer sk-deadbeefdeadbeefdeadbeefdeadbeef" },
					},
					{ type: "text", text: "Sending an email to john.doe@example.com" },
				],
			},
		]
		const result = (await redactMessages(messages)) as Array<{
			content: Array<Record<string, unknown>>
		}>

		// toolCall block untouched — JSON structure intact
		const toolCall = result[0].content[0]
		expect(toolCall.type).toBe("toolCall")
		expect(toolCall.input).toEqual({
			to: "john.doe@example.com",
			body: "Bearer sk-deadbeefdeadbeefdeadbeefdeadbeef",
		})

		// Text block redacted
		const textBlock = result[0].content[1]
		expect(textBlock.type).toBe("text")
		expect(textBlock.text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(textBlock.text).not.toContain("john.doe@example.com")
	})

	it("handles string content (not just content blocks)", async () => {
		const messages = [{ role: "system", content: "SSN: 489-36-2157 is on file" }]
		const result = (await redactMessages(messages)) as Array<{ content: string }>
		expect(result[0].content).toContain("[REDACTED-US_SSN]")
		expect(result[0].content).not.toContain("489-36-2157")
	})

	it("passes through non-object messages unchanged", async () => {
		const messages = [null, undefined, "string", 42]
		const result = await redactMessages(messages)
		expect(result[0]).toBeNull()
		expect(result[1]).toBeUndefined()
		expect(result[2]).toBe("string")
		expect(result[3]).toBe(42)
	})

	it("redacts multiple PII types in a single message", async () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Email: john.doe@example.com, SSN: 489-36-2157, CC: 4532015112830366",
					},
				],
			},
		]
		const result = (await redactMessages(messages)) as Array<{
			content: Array<{ text: string }>
		}>
		const text = result[0].content[0].text
		expect(text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(text).toContain("[REDACTED-US_SSN]")
		expect(text).toContain("[REDACTED-CREDIT_CARD]")
		expect(text).not.toContain("john.doe@example.com")
		expect(text).not.toContain("489-36-2157")
		expect(text).not.toContain("4532015112830366")
	})
})

describe("getRedactionConfig — opt-out paths", () => {
	let savedHome: string | undefined
	let savedEnv: string | undefined
	let tmpHome: string

	beforeEach(() => {
		savedHome = process.env.HOME
		savedEnv = process.env.KIMCHI_REDACTION_ENABLED
		tmpHome = mkdtempSync(join(tmpdir(), "kimchi-redact-home-"))
		process.env.HOME = tmpHome
		process.env.KIMCHI_REDACTION_ENABLED = ""
		resetRedactionConfigCache()
	})

	afterEach(() => {
		if (savedHome !== undefined) process.env.HOME = savedHome
		else process.env.HOME = ""
		if (savedEnv !== undefined) process.env.KIMCHI_REDACTION_ENABLED = savedEnv
		else process.env.KIMCHI_REDACTION_ENABLED = ""
		resetRedactionConfigCache()
	})

	/** Write a global config.json in the temp HOME so loadConfig picks it up */
	function writeConfig(data: Record<string, unknown>): void {
		const configDir = join(tmpHome, ".config", "kimchi")
		mkdirSync(configDir, { recursive: true })
		writeFileSync(join(configDir, "config.json"), JSON.stringify(data), "utf-8")
		resetRedactionConfigCache()
	}

	it("defaults to enabled when no config and no env", () => {
		const config = getRedactionConfig()
		expect(config.enabled).toBe(true)
	})

	it("disables via KIMCHI_REDACTION_ENABLED=0 env var", () => {
		process.env.KIMCHI_REDACTION_ENABLED = "0"
		resetRedactionConfigCache()
		const config = getRedactionConfig()
		expect(config.enabled).toBe(false)
	})

	it("disables via KIMCHI_REDACTION_ENABLED=false env var", () => {
		process.env.KIMCHI_REDACTION_ENABLED = "false"
		resetRedactionConfigCache()
		const config = getRedactionConfig()
		expect(config.enabled).toBe(false)
	})

	it("disables via config.json redaction.enabled=false", () => {
		writeConfig({ redaction: { enabled: false } })
		const config = getRedactionConfig()
		expect(config.enabled).toBe(false)
	})

	it("env var overrides config.json (env=0 wins over config=true)", () => {
		writeConfig({ redaction: { enabled: true } })
		process.env.KIMCHI_REDACTION_ENABLED = "0"
		resetRedactionConfigCache()
		const config = getRedactionConfig()
		expect(config.enabled).toBe(false)
	})

	it("falls back to default when config.json is malformed", () => {
		const configDir = join(tmpHome, ".config", "kimchi")
		mkdirSync(configDir, { recursive: true })
		writeFileSync(join(configDir, "config.json"), "{ not valid json", "utf-8")
		resetRedactionConfigCache()
		const config = getRedactionConfig()
		expect(config.enabled).toBe(true)
	})

	it("falls back to default when redaction key is missing", () => {
		writeConfig({ theme: "dark" })
		const config = getRedactionConfig()
		expect(config.enabled).toBe(true)
	})
})
