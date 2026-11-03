import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidateJsonCache } from "../../config/json.js"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { getResourceSettingsPath, setResourceOverride } from "../../resources/store.js"
import { getRedactionConfig } from "./config.js"
import { getDefaultExcludedEntities } from "./entity-tiers.js"
import {
	applyCustomPatterns,
	getRedactionConfigError,
	redactMessages,
	redactObjectStrings,
	redactObjectStringsStrict,
	redactText,
	redactTextOrThrow,
	resetRedactorEngine,
} from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"

// ─── Fixture assembly ────────────────────────────────────────────────────────
// Fixture VALUES are assembled at runtime, never written as literals: this
// file is itself edited by agents whose pipeline redacts write arguments,
// so a literal email address or an "aws_secret_access_key = …" line would be
// replaced by a marker on disk before the test ever runs. Assembling from
// innocuous fragments keeps the source byte-stable under self-redaction.
const fx = {
	email: ["jane.doe", "example.com"].join("@"),
	phone: ["+1", "(415)", "555", "0132"].join(" "),
	ssn: ["219", "09", "9999"].join("-"), // valid shape, unassigned area — 123-45-6789 is sample-filtered by the engine
	creditCard: ["4532", "0151", "1283", "0366"].join(""), // Luhn-valid
	iban: ["DE89", "3704", "0044", "0532", "0130", "00"].join(" "), // mod-97-valid
	bearerValue: ["ey", "JhbGciOiJIUzI1Ni", "J9.test123", "-AbCdEfGh"].join(""),
	awsAccessKey: ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
	awsSecret: ["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLE", "KEY"].join(""), // 40 chars
	ghpToken: ["ghp_", "n1".repeat(18)].join(""),
	ghPatToken: ["github_pat_", "11A".repeat(8), "ZZ9z"].join(""),
	castaiKey: ["castai_v1_", "Ab3".repeat(7), "x"].join(""),
	oauthToken: ["ya29", ".", "a0AfH6SMBx".repeat(2)].join(""),
	skKey: ["sk-", "liveTe".repeat(4), "9z"].join(""),
	skProjKey: ["sk-proj-", "x1".repeat(15)].join(""),
	localPath: ["", "Users", "jane", ".ssh", "id_rsa"].join("/"),
	credentialFile: ["~", "/.ssh/", "id_ed25519"].join(""),
	// Bare-shape regression fixtures (previously false-positived).
	sha40: "a89b3cd4".repeat(5), // git commit SHA shape
	isoDate: [["2026", "11", "02"].join("-"), "T", "21:27:58", ".323Z"].join(""),
	varFolders: ["/var/folders/sl/", "j50k6cnn5h1_f4sz6ktrtlw80000gn", "/T/", "x1y2z3".repeat(7)].join(""), // 42-char tail
	pipelineId: "5570509412",
	plainUrl: ["https", "://", "developer.mozilla.org", "/en-US/docs/Web"].join(""),
	// Anchored secret fixtures.
	userinfoUrl: ["postgresql", "://", "svc-user", ":", "p4ss", "w0rd99", "@", "db.internal", "/app"].join(""),
	userinfoPassword: ["p4ss", "w0rd99"].join(""),
	queryTokenUrl: ["https", "://", "api.example", ".com", "/x", "?", "token", "=", "abc123XYZ", "890123"].join(""),
	queryTokenSecret: ["abc123XYZ", "890123"].join(""),
	azureConnString: [
		"DefaultEndpointsProtocol=https;AccountName=store;AccountKey=",
		"K7xQ".repeat(11),
		"==",
		";EndpointSuffix=core.windows.net",
	].join(""),
	azureAccountKey: ["K7xQ".repeat(11), "=="].join(""),
	basicAuthHeader: ["Authorization: Basic ", "dXNlcjpwYXNzd29yZA", "=="].join(""),
	ipAddress: ["203", "0", "113", "7"].join("."), // TEST-NET-3
	uuid: "019f36c2-1b53-71ed-afc8-faded478f42a",
} as const

/** Helper: assert that text was redacted (original gone, marker present). */
function expectRedacted(result: string, original: string, markerType: string): void {
	expect(result).not.toContain(original)
	expect(result).toContain(`[REDACTED-${markerType}]`)
}

describe("redactText — per-category PII redaction", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts email addresses", async () => {
		const result = await redactText(`Contact ${fx.email} for details`)
		expectRedacted(result, fx.email, "EMAIL_ADDRESS")
		expect(result).toContain("Contact")
		expect(result).toContain("for details")
	})

	it("redacts credit cards (Luhn-valid)", async () => {
		const result = await redactText(`CC: ${fx.creditCard}`)
		expectRedacted(result, fx.creditCard, "CREDIT_CARD")
	})

	it("redacts IBANs (mod-97 valid)", async () => {
		const result = await redactText(`IBAN: ${fx.iban}`)
		expectRedacted(result, fx.iban, "IBAN_CODE")
	})

	it("redacts Bearer tokens", async () => {
		const result = await redactText(`Bearer ${fx.bearerValue}`)
		expect(result).not.toContain(fx.bearerValue)
		expect(result).toContain("[REDACTED-BEARER_TOKEN]")
	})

	it("redacts AWS access keys (AKIA…)", async () => {
		const result = await redactText(`AWS_KEY=${fx.awsAccessKey}`)
		expectRedacted(result, fx.awsAccessKey, "AWS_ACCESS_KEY")
	})

	it("redacts GitHub tokens — labeled GITHUB_TOKEN, not mislabeled CRYPTO", async () => {
		// Tier change: with CRYPTO excluded, the custom gh-pattern now owns the
		// whole token; before, the engine's CRYPTO guard ate the numeric tail
		// and mislabeled it.
		const result = await redactText(`Token ${fx.ghpToken} leaked`)
		expectRedacted(result, fx.ghpToken, "GITHUB_TOKEN")
	})

	it("returns original text when no PII is present", async () => {
		const clean = "This is a perfectly safe message with no secrets."
		const result = await redactText(clean)
		expect(result).toBe(clean)
	})
})

describe("redactText — bare-shape tier: former false positives stay intact", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("ignores git commit SHAs (40-hex)", async () => {
		const input = `commit ${fx.sha40}`
		expect(await redactText(input)).toBe(input)
	})

	it("ignores ISO-8601 timestamps", async () => {
		const input = `created_at: ${fx.isoDate}`
		expect(await redactText(input)).toBe(input)
	})

	it("ignores macOS /var/folders temp-path tails (40-char base64 run)", async () => {
		const input = `sandbox note at ${fx.varFolders}`
		expect(await redactText(input)).toBe(input)
	})

	it("ignores CI pipeline/build digit runs", async () => {
		const input = `pipeline ${fx.pipelineId} completed`
		expect(await redactText(input)).toBe(input)
	})

	it("leaves plain documentation URLs intact", async () => {
		const input = `see ${fx.plainUrl} for reference`
		expect(await redactText(input)).toBe(input)
	})

	it("does not redact bare phone-number shapes", async () => {
		const input = `Call ${fx.phone} to reach support`
		expect(await redactText(input)).toBe(input)
	})

	it("does not redact SSN shapes", async () => {
		const input = `SSN: ${fx.ssn}`
		expect(await redactText(input)).toBe(input)
	})

	it("still redacts IP addresses (shape-precise, kept on)", async () => {
		const result = await redactText(`bind ${fx.ipAddress}`)
		expectRedacted(result, fx.ipAddress, "IP_ADDRESS")
	})
})

describe("redactText — anchored secret patterns", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts an AWS secret key only when keyword-anchored", async () => {
		const anchored = await redactText(`aws_secret_access_key = "${fx.awsSecret}"`)
		expectRedacted(anchored, fx.awsSecret, "AWS_SECRET_KEY")
		expect(anchored).toContain("aws_secret_access_key")

		// The identical 40-char run without a keyword is left intact —
		// bare-shape precision: temp paths and hashes look the same.
		const bare = `replica sharer ${fx.awsSecret} tail`
		expect(await redactText(bare)).toBe(bare)
	})

	it("redacts keyword-anchored values even when shorter or longer than 40 chars", async () => {
		// Export is fail-closed: the keyword carries the precision, so a
		// truncated (39-char) or padded value must still redact.
		const short = ["aws_secret_access_key = ", "wJalrXUtnFEMI".repeat(3)].join("")
		const shortOut = await redactText(short)
		expect(shortOut).not.toContain(["wJalrXUtnFEMI".repeat(3)].join(""))
		expect(shortOut).toContain("AWS_SECRET_KEY")

		const long = `aws_secret_access_key = ${["K7xQ".repeat(11), "=="].join("")}`
		const longOut = await redactText(long)
		expect(longOut).not.toContain(["K7xQ".repeat(11)].join(""))
	})

	it("redacts AccountKey values inside connection strings", async () => {
		const result = await redactText(fx.azureConnString)
		expectRedacted(result, fx.azureAccountKey, "AZURE_STORAGE_KEY")
		expect(result).toContain("AccountKey=")
	})

	it("redacts Basic authorization headers", async () => {
		const result = await redactText(fx.basicAuthHeader)
		expect(result).toContain("[REDACTED-BASIC_AUTH]")
		expect(result).not.toContain("dXNlcjpwYXNzd29yZA")
		expect(result).toContain("Authorization: Basic ")
	})

	it("removes URL userinfo passwords", async () => {
		// The engine's EMAIL guard typically claims the userinfo span; span
		// boundaries (user, host) are engine internals — pin only the contract:
		// the password is gone and a marker stands in its place.
		const result = await redactText(`db at ${fx.userinfoUrl}`)
		expect(result).not.toContain(fx.userinfoPassword)
		expect(result).toContain("[REDACTED-")
	})

	it("redacts secret-shaped query parameters", async () => {
		const result = await redactText(`call ${fx.queryTokenUrl}`)
		expectRedacted(result, fx.queryTokenSecret, "URL_WITH_CREDENTIALS")
		expect(result).toContain("?token=")
	})
})

describe("redactMessages — message structure preservation", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts text blocks in user messages without mutating input", async () => {
		const original = [
			{
				role: "user",
				content: [{ type: "text", text: `My email is ${fx.email}` }],
			},
		]
		const result = (await redactMessages(original)) as Array<{ content: Array<{ type: string; text: string }> }>

		expect(original[0].content[0].text).toBe(`My email is ${fx.email}`)
		expect(result[0].content[0].text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result[0].content[0].text).not.toContain(fx.email)
		expect(result[0].content[0].type).toBe("text")
	})

	it("redacts PII inside tool-call arguments", async () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_001",
						toolName: "send_email",
						input: { to: fx.email, body: `Bearer ${fx.bearerValue}` },
					},
					{ type: "text", text: `Sending an email to ${fx.email}` },
				],
			},
		]
		const result = (await redactMessages(messages)) as Array<{
			content: Array<Record<string, unknown>>
		}>

		const toolCall = result[0].content[0]
		expect(toolCall.type).toBe("toolCall")
		expect(toolCall.id).toBe("call_001")
		expect(toolCall.toolName).toBe("send_email")
		expect(toolCall.input).not.toMatchObject({ to: fx.email })
		expect(JSON.stringify(toolCall.input)).toContain("[REDACTED-EMAIL_ADDRESS]")

		const textBlock = result[0].content[1]
		expect(textBlock.type).toBe("text")
		expect(textBlock.text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(textBlock.text).not.toContain(fx.email)
	})

	it("handles string content (not just content blocks)", async () => {
		const messages = [{ role: "user", content: `Reach me at ${fx.email} anytime` }]
		const result = (await redactMessages(messages)) as Array<{ content: string }>
		expect(result[0].content).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result[0].content).not.toContain(fx.email)
	})

	it("passes through non-object messages unchanged", async () => {
		const messages = [null, undefined, "string", 42]
		const result = await redactMessages(messages)
		expect(result[0]).toBeNull()
		expect(result[1]).toBeUndefined()
		expect(result[2]).toBe("string")
		expect(result[3]).toBe(42)
	})

	it("skips system messages to preserve structural identifiers", async () => {
		const messages = [
			{ role: "system", content: `ferment_id: ${fx.uuid}` },
			{ role: "user", content: `My email is ${fx.email}` },
		]
		const result = (await redactMessages(messages)) as Array<{ role: string; content: string }>
		expect(result[0].content).toContain(fx.uuid)
		expect(result[0].content).not.toContain("[REDACTED")
		expect(result[1].content).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result[1].content).not.toContain(fx.email)
	})

	it("redacts multiple PII types in a single message; bare shapes survive", async () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `Email: ${fx.email}, SSN: ${fx.ssn}, CC: ${fx.creditCard}`,
					},
				],
			},
		]
		const result = (await redactMessages(messages)) as Array<{
			content: Array<{ text: string }>
		}>
		const text = result[0].content[0].text
		expect(text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(text).toContain("[REDACTED-CREDIT_CARD]")
		expect(text).not.toContain(fx.email)
		expect(text).not.toContain(fx.creditCard)
		// SSN shapes are bare-tier: no longer redacted, no marker forged.
		expect(text).toContain(fx.ssn)
		expect(text).not.toContain("[REDACTED-US_SSN]")
	})
})

describe("redactText — custom secret patterns", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts CastAI API keys (castai_v1_)", async () => {
		const result = await redactText(`API key: ${fx.castaiKey}`)
		expectRedacted(result, fx.castaiKey, "CASTAI_API_KEY")
	})

	it("redacts Bearer tokens (only the token part)", async () => {
		const result = await redactText(`Authorization: Bearer ${fx.bearerValue}`)
		expect(result).not.toContain(fx.bearerValue)
		// The engine claims the span wholesale; the custom pattern's prefix
		// preservation only shows when the engine defers to it.
		expect(result).toContain("[REDACTED-BEARER_TOKEN]")
	})

	it("redacts OAuth tokens (ya29.*)", async () => {
		const result = await redactText(`token: ${fx.oauthToken}`)
		expectRedacted(result, fx.oauthToken, "OAUTH_TOKEN")
	})

	it("redacts local auth/config paths", async () => {
		const result = await redactText(`Config at ${fx.localPath}`)
		expectRedacted(result, fx.localPath, "LOCAL_PATH")
	})

	it("redacts SSH credential file paths", async () => {
		const result = await redactText(`Key at ${fx.credentialFile}`)
		expectRedacted(result, fx.credentialFile, "CREDENTIAL_FILE")
	})

	it("redacts OpenAI-style API keys (sk-, sk-proj-)", async () => {
		const result = await redactText(`Gateway key: ${fx.skKey}, old ${fx.skProjKey}`)
		expect(result).not.toContain(fx.skKey)
		expect(result).not.toContain(fx.skProjKey)
		expect(result).toContain("[REDACTED-OPENAI_API_KEY]")
		expect(result).toContain("Gateway key:")
	})

	it("redacts standalone GitHub tokens whole (ghp_ numeric tails, mixed PATs)", async () => {
		const result = await redactText(`Token ${fx.ghpToken} leaked`)
		expectRedacted(result, fx.ghpToken, "GITHUB_TOKEN")

		const pat = await redactText(`PAT ${fx.ghPatToken} in log`)
		expectRedacted(pat, fx.ghPatToken, "GITHUB_TOKEN")
	})
})

describe("redactObjectStrings — sensitive JSON fields", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("redacts password field", async () => {
		const result = await redactObjectStrings({ password: "abc123" })
		expect(result).toEqual({ password: "[REDACTED-SECRET_FIELD]" })
	})

	it("redacts token field", async () => {
		const result = await redactObjectStrings({ token: "bearer_xyz" })
		expect(result).toEqual({ token: "[REDACTED-SECRET_FIELD]" })
	})

	it("redacts secret field", async () => {
		const result = await redactObjectStrings({ secret: "my_secret_value" })
		expect(result).toEqual({ secret: "[REDACTED-SECRET_FIELD]" })
	})

	it("redacts auth-wrapped token field", async () => {
		const result = await redactObjectStrings({ auth: { token: "secret123" } })
		expect(result).toEqual({ auth: { token: "[REDACTED-SECRET_FIELD]" } })
	})

	it("redacts apiKey field (camelCase)", async () => {
		const result = await redactObjectStrings({ apiKey: "key_abc123" })
		expect(result).toEqual({ apiKey: "[REDACTED-SECRET_FIELD]" })
	})

	it("redacts nested sensitive fields", async () => {
		const result = await redactObjectStrings({ config: { credentials: { clientSecret: "sec_789" } } })
		expect(result).toEqual({ config: { credentials: { clientSecret: "[REDACTED-SECRET_FIELD]" } } })
	})

	it("does not redact client_id — identifiers are not secrets", async () => {
		const result = await redactObjectStrings({ client_id: "web-client-8421", client_secret: "shh-real" })
		expect(result).toEqual({ client_id: "web-client-8421", client_secret: "[REDACTED-SECRET_FIELD]" })
	})

	it("preserves non-sensitive fields", async () => {
		const result = await redactObjectStrings({ name: "test", count: 42, items: ["a", "b"] })
		expect(result).toEqual({ name: "test", count: 42, items: ["a", "b"] })
	})

	it("preserves symbol metadata while redacting its value", async () => {
		const marker = Symbol.for("kimchi.assistant-output-withheld")
		const result = await redactObjectStrings({
			[marker]: fx.email,
			content: fx.email,
		})

		expect(result[marker]).toBe("[REDACTED-EMAIL_ADDRESS]")
		expect(result.content).toBe("[REDACTED-EMAIL_ADDRESS]")
	})
})

describe("redactObjectStrings — trace ID preservation", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("preserves traceId and traceIds while redacting sibling secrets", async () => {
		const input = {
			traceId: "9f4e8d2c1b0a5f6e",
			traceIds: ["9f4e8d2c1b0a5f6e", "diag-trace-123"],
			apiKey: fx.skKey,
			message: `Key: ${fx.awsAccessKey}`,
		}
		const result = await redactObjectStrings(input)
		expect(result.traceId).toBe("9f4e8d2c1b0a5f6e")
		expect(result.traceIds).toEqual(["9f4e8d2c1b0a5f6e", "diag-trace-123"])
		expect(result.apiKey).toBe("[REDACTED-SECRET_FIELD]")
		expect(result.message).toContain("[REDACTED-AWS_ACCESS_KEY]")
		expect(result.message).not.toContain(fx.awsAccessKey)
	})

	it("preserves traceId when undefined", async () => {
		const result = await redactObjectStrings({ traceId: undefined, name: "x" })
		expect(result).toEqual({ traceId: undefined, name: "x" })
	})

	it("preserves nested traceIds inside request_diagnostics entries", async () => {
		const input = {
			type: "custom",
			customType: "request_diagnostics",
			data: {
				status: 200,
				traceId: "diag-trace-123",
				apiKey: fx.skKey,
			},
		}
		const result = await redactObjectStrings(input)
		expect(result.data.traceId).toBe("diag-trace-123")
		expect(result.data.apiKey).toBe("[REDACTED-SECRET_FIELD]")
		expect(result.data.status).toBe(200)
	})
})

describe("getRedactionConfig — resources-system enablement", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-settings-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
	})

	afterEach(() => {
		resetOrgPolicyForTests()
		vi.unstubAllEnvs()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	it("defaults to disabled — no override, no env, no org policy", () => {
		expect(getRedactionConfig().enabled).toBe(false)
	})

	it("KIMCHI_ENABLE_RESOURCES enables transiently", () => {
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", PII_REDACTION_RESOURCE_ID)
		expect(getRedactionConfig().enabled).toBe(true)
	})

	it("a persistent /resources override enables it", () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)

		expect(getRedactionConfig().enabled).toBe(true)
	})

	it("a persistent disable beats the env enable", () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, false)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", PII_REDACTION_RESOURCE_ID)

		expect(getRedactionConfig().enabled).toBe(false)
	})

	it("org ON is a soft default — enables, and a local disable still wins", async () => {
		await setOrgPolicyForTests({ resources: { [PII_REDACTION_RESOURCE_ID]: "ON" } })

		expect(getRedactionConfig().enabled).toBe(true)
		setResourceOverride(PII_REDACTION_RESOURCE_ID, false)
		expect(getRedactionConfig().enabled).toBe(false)
	})

	it("org FORCE_ON locks it on, beating a pre-existing local disable", async () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, false)
		await setOrgPolicyForTests({ resources: { [PII_REDACTION_RESOURCE_ID]: "FORCE_ON" } })

		expect(getRedactionConfig().enabled).toBe(true)
	})

	it("org FORCE_OFF beats a pre-existing local enable and the env var", async () => {
		setResourceOverride(PII_REDACTION_RESOURCE_ID, true)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", PII_REDACTION_RESOURCE_ID)
		await setOrgPolicyForTests({ resources: { [PII_REDACTION_RESOURCE_ID]: "FORCE_OFF" } })

		expect(getRedactionConfig().enabled).toBe(false)
	})

	it("a malformed settings.json throws — the platform's fail-visible convention", () => {
		writeFileSync(join(codingAgentDir, "settings.json"), "{ not valid json")

		// Org FORCE_* policies are checked before the settings read, so only
		// unmanaged or soft-defaulted deployments hit this path; the behavior
		// matches the bash tool-blocker, which already fails visible on the
		// same corrupt file.
		expect(() => getRedactionConfig()).toThrow()
	})
})

describe("getRedactionConfig — redaction.excludedEntities settings", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-excl-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
	})

	afterEach(() => {
		resetRedactorEngine()
		resetOrgPolicyForTests()
		vi.unstubAllEnvs()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	function writeSettings(redaction: unknown): void {
		writeFileSync(join(codingAgentDir, "settings.json"), JSON.stringify({ redaction }))
		invalidateJsonCache(getResourceSettingsPath())
	}

	it("absent key → tier-registry defaults, empty user list", () => {
		const config = getRedactionConfig()
		expect(config.excludedEntities).toEqual(getDefaultExcludedEntities())
		expect(config.userExcludedEntities).toEqual([])
	})

	it("a present array replaces the defaults wholesale (raw list exposed)", () => {
		writeSettings({ excludedEntities: ["GUID"] })
		const config = getRedactionConfig()
		expect(config.excludedEntities).toEqual(["GUID"])
		expect(config.userExcludedEntities).toEqual(["GUID"])
	})

	it("unknown entity names throw (fail-visible)", () => {
		writeSettings({ excludedEntities: ["NOPE_NOT_AN_ENTITY"] })
		expect(() => getRedactionConfig()).toThrow(/unknown entity/)
	})

	it("non-array values throw", () => {
		writeSettings({ excludedEntities: "DATE_TIME" })
		expect(() => getRedactionConfig()).toThrow(/array of strings/)
	})

	it("FORCE locks skip the settings read — a corrupt local block cannot break a locked deployment", async () => {
		writeSettings({ excludedEntities: ["NOPE_NOT_AN_ENTITY"] })
		await setOrgPolicyForTests({ resources: { [PII_REDACTION_RESOURCE_ID]: "FORCE_ON" } })
		const config = getRedactionConfig()
		expect(config.enabled).toBe(true)
		expect(config.excludedEntities).toEqual(getDefaultExcludedEntities())
	})

	it("user-replaced exclusions re-enable bare-shape detection (replace semantics)", async () => {
		// Default: SSN shape survives. User replaces the list with GUID-only
		// → engine no longer excludes US_SSN → it redacts again.
		resetRedactorEngine()
		const before = await redactTextOrThrow(`SSN: ${fx.ssn}`)
		expect(before).not.toContain("[REDACTED-US_SSN]")

		writeSettings({ excludedEntities: ["GUID"] })
		resetRedactorEngine()
		const after = await redactTextOrThrow(`SSN: ${fx.ssn}`)
		expect(after).toContain("[REDACTED-US_SSN]")
	})

	it("user exclusions filter kimchi-owned custom patterns (LOCAL_PATH)", async () => {
		writeSettings({ excludedEntities: [...getDefaultExcludedEntities(), "LOCAL_PATH"] })
		resetRedactorEngine()
		const result = await redactTextOrThrow(`Config at ${fx.localPath}`)
		expect(result).toContain(fx.localPath)
		expect(result).not.toContain("[REDACTED-LOCAL_PATH]")
	})

	it("defaults never filter the anchored re-additions (AWS_SECRET_KEY stays covered)", async () => {
		resetRedactorEngine()
		const result = await redactTextOrThrow(`aws_secret_access_key=${fx.awsSecret}`)
		expectRedacted(result, fx.awsSecret, "AWS_SECRET_KEY")
	})
})

describe("anchored splice and re-additions — review regressions", () => {
	beforeEach(() => resetRedactorEngine())
	afterEach(() => resetRedactorEngine())

	it("splices by position: a password equal to the username does not survive (no substring replace)", () => {
		// Regression for the substring-replace bug: with user == pass, the
		// first occurrence of the secret text is inside the anchor, and the
		// old match.replace(secret, marker) marked the username while the
		// password passed through next to a redaction marker.
		const input = ["db at postgres", "ql://", "admin", ":", "admin", "@db.internal/app"].join("")
		const out = applyCustomPatterns(input, new Set())
		expect(out).not.toContain("admin") // neither user nor pass may survive
		expect(out).toContain("[REDACTED-URL_WITH_CREDENTIALS]")
		expect(out).toContain("db.internal/app")
	})

	it("splices by position when the keyword itself contains the secret text", () => {
		// The value ('Authoriz') is a prefix of the anchor ('Authorization: ') —
		// a substring search would marker the anchor and leak the value; the
		// positional splice must redact the value and keep the anchor.
		const value = "Authoriz"
		const out = applyCustomPatterns(["Authorization", ": Basic ", value].join(""), new Set())
		expect(out).toBe("Authorization: Basic [REDACTED-BASIC_AUTH]")
	})

	it("preserves the Bearer prefix byte-for-byte (no case rewriting)", () => {
		const token = ["ey", "JhbGciOiJIUzI1Ni".toLowerCase(), "x9".repeat(8)].join("")
		const out = applyCustomPatterns(`authorization: bearer ${token}`, new Set())
		expect(out).toBe(`authorization: bearer [REDACTED-BEARER_TOKEN]`)
	})

	it("re-adds TELEGRAM_BOT_TOKEN and OKTA_TOKEN behind their keywords only", async () => {
		const tg = ["123456789:AA", "x".repeat(33)].join("") // <digits>:<35 chars>
		const okta = ["a", "0".repeat(41)].join("") // 42-char base62-ish
		// Bare shapes survive (tier-registry default excludes them).
		const bare = `token blob ${tg} and ${okta} tail`
		expect(await redactText(bare)).toBe(bare)
		// Keyword-anchored forms redact.
		const anchored = await redactText(`telegram_bot_token=${tg} okta_token: ${okta}`)
		expect(anchored).not.toContain(tg)
		expect(anchored).not.toContain(okta)
		expect(anchored).toContain("[REDACTED-TELEGRAM_BOT_TOKEN]")
		expect(anchored).toContain("[REDACTED-OKTA_TOKEN]")
	})
})

describe("settings validation failure — degrade, never silently bypass", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-badcfg-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
	})

	afterEach(() => {
		resetRedactorEngine()
		resetOrgPolicyForTests()
		vi.unstubAllEnvs()
		rmSync(codingAgentDir, { recursive: true, force: true })
	})

	function writeSettings(redaction: unknown): void {
		writeFileSync(join(codingAgentDir, "settings.json"), JSON.stringify({ redaction }))
		invalidateJsonCache(getResourceSettingsPath())
	}

	it("a typo'd exclusion list degrades to defaults — redaction stays ON", async () => {
		writeSettings({ excludedEntities: ["SSN"] }) // unknown: real name is US_SSN
		resetRedactorEngine()
		// The lenient path must keep redacting with the registry defaults —
		// NOT swallow the config error into a full bypass.
		const result = await redactText(`mail ${fx.email} key ${["sk-", "liveTe".repeat(4), "9z"].join("")}`)
		expect(result).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(getRedactionConfigError()).toBeDefined()
	})

	it("the strict export path fails closed on the same typo", async () => {
		writeSettings({ excludedEntities: ["SSN"] })
		resetRedactorEngine()
		await expect(redactObjectStringsStrict({ a: "hello" })).rejects.toThrow(/redaction settings invalid/)
	})

	it("fixing the settings clears the error and restores the export path", async () => {
		writeSettings({ excludedEntities: ["SSN"] })
		resetRedactorEngine()
		await expect(redactObjectStringsStrict({ a: "hello" })).rejects.toThrow(/redaction settings invalid/)
		writeSettings({ excludedEntities: ["GUID"] })
		resetRedactorEngine()
		const out = await redactObjectStringsStrict({ a: "hello" })
		expect(out).toEqual({ a: "hello" })
		expect(getRedactionConfigError()).toBeUndefined()
	})

	it("a non-object redaction block throws like a malformed key", () => {
		writeSettings("junk")
		expect(() => getRedactionConfig()).toThrow(/must be an object/)
	})
})

describe("redactObjectStringsStrict — fail-closed export variant", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-strict-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})
	afterEach(() => {
		vi.unstubAllEnvs()
		rmSync(codingAgentDir, { recursive: true, force: true })
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})

	it("throws on an engine failure while the lenient variant returns the original text", async () => {
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))
		const secret = { nested: { content: `call me at ${fx.email}` } }

		await expect(redactObjectStringsStrict(secret)).rejects.toThrow("engine exploded")

		// Lenient contract unchanged: a scan failure returns the original text.
		const lenient = await redactObjectStrings(secret)
		expect(lenient.nested.content).toBe(`call me at ${fx.email}`)
	})

	it("walk parity with the lenient variant on a fixture object", async () => {
		interface FixtureEntry {
			id: string
			type: string
			message?: { role: string; content: string }
			customType?: string
			data?: { traceId: string; apiKey: string }
		}
		const fixture: { header: { id: string }; entries: FixtureEntry[]; systemPrompt: string } = {
			header: { id: "s1" },
			entries: [
				{ id: "m1", type: "message", message: { role: "user", content: `email ${fx.email}` } },
				{ id: "m2", type: "custom", customType: "diagnostics", data: { traceId: "abc123", apiKey: fx.skKey } },
			],
			systemPrompt: `You are helpful. Bearer ${fx.skKey}${fx.bearerValue}`,
		}

		const lenient = await redactObjectStrings(structuredClone(fixture))
		const strict = await redactObjectStringsStrict(structuredClone(fixture))

		expect(strict).toEqual(lenient)
		// Both variants actually redacted (sanity: the fixture contains PII).
		expect(JSON.stringify(strict)).not.toContain(fx.email)
		expect(JSON.stringify(strict)).toContain("[REDACTED-EMAIL_ADDRESS]")
		// Sensitive-key force-redaction identical.
		expect(strict.entries[1]?.data?.apiKey).toBe("[REDACTED-SECRET_FIELD]")
		// Preserved keys identical.
		expect(strict.entries[1]?.data?.traceId).toBe("abc123")
		// Input never mutated by either variant.
		expect(fixture.entries[0]?.message?.content).toContain(fx.email)
	})

	it("bare-shape spans survive the strict variant too — and that is intended", async () => {
		// Pin the deliberate behavior change: exports no longer redact
		// context-free shapes (SHAs, timestamps); anchored/checksum coverage
		// still applies on the strict path.
		const entries = [{ message: `commit ${fx.sha40} at ${fx.isoDate}, CC ${fx.creditCard}` }]
		const strict = await redactObjectStringsStrict(entries)
		expect(strict[0]?.message).toContain(fx.sha40)
		expect(strict[0]?.message).toContain(fx.isoDate)
		expect(strict[0]?.message).toContain("[REDACTED-CREDIT_CARD]")
		expect(strict[0]?.message).not.toContain(fx.creditCard)
	})
})

// Toggleable engine-analyze override for the strict-variant failure tests.
// When `scanImpl` is null (the default) createEngine returns the real engine,
// so every other test in this file exercises the real redaction behavior; the
// strict tests set a rejecting analyze to simulate an engine failure.
const engineScanOverride = vi.hoisted(() => ({
	scanImpl: null as ((text: string) => Promise<unknown>) | null,
}))

vi.mock("@bulkhead-ai/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bulkhead-ai/core")>()
	return {
		...actual,
		createEngine: (...args: Parameters<typeof actual.createEngine>) => {
			const engine = actual.createEngine(...args)
			if (!engineScanOverride.scanImpl) return engine
			// Delegate to the real engine but intercept `analyze` — Object.create
			// keeps the prototype (setExcludeEntities etc.) intact. The redactor
			// composes from analyze() (see redactor.ts), never calls scan().
			const overridden = Object.create(engine) as typeof engine
			overridden.analyze = engineScanOverride.scanImpl as typeof engine.analyze
			return overridden
		},
	}
})
