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
	collectDetections,
	createRedactionEngine,
	getRedactionConfigError,
	isBase64ShadowDrop,
	isGenericLocalPart,
	isNonIdentifyingDetection,
	isNonIdentifyingEmail,
	isNonSensitiveIp,
	isSelfIdentity,
	isTechnicalEmailDomain,
	redactMessages,
	redactObjectStrings,
	redactObjectStringsMeasured,
	redactObjectStringsStrict,
	redactText,
	redactTextOrThrow,
	resetRedactorEngine,
} from "./redactor.js"
import { PII_REDACTION_RESOURCE_ID } from "./resource.js"
import { createTokenVault, resetTokenVaults, substituteTokens } from "./vault.js"

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
	ipAddress: ["93", "184", "216", "34"].join("."), // public address: TEST-NET is filtered as non-identifying
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
		expectRedacted(result, fx.azureAccountKey, "AZURE_CONNECTION_STRING")
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

	it("labels sk-ant- keys ANTHROPIC_KEY, not OPENAI_API_KEY", async () => {
		const key = ["sk-ant-", "a".repeat(24), "9K"].join("")
		const result = await redactText(`claude key: ${key}`)
		expect(result).not.toContain(key)
		expect(result).toContain("[REDACTED-ANTHROPIC_KEY]")
		expect(result).not.toContain("[REDACTED-OPENAI_API_KEY]")
	})

	it("short-tailed sk-ant- keys keep the pre-split coverage floor", async () => {
		const key = ["sk-ant-", "K9", "d7q2"].join("")
		const result = await redactText(`key: ${key}`)
		expect(result).not.toContain(key)
		expect(result).toContain("[REDACTED-ANTHROPIC_KEY]")
	})

	it("relates realistic-length sk-ant- keys to ANTHROPIC_KEY even when the engine claims them (correctness-001)", async () => {
		const key = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8".repeat(6)
		const text = `claude key: ${key}`
		const result = await redactText(text)
		expect(result).not.toContain(key)
		expect(result).toContain("[REDACTED-ANTHROPIC_KEY]")
		expect(result).not.toContain("[REDACTED-OPENAI_KEY]")
	})

	it("honors user exclusions on the relabeled label (correctness-007)", async () => {
		const key = "sk-ant-api03-" + "a1B2c3D4e5F6g7H8".repeat(6)
		const text = `claude key: ${key}`
		const engine = createRedactionEngine(getDefaultExcludedEntities().filter((e) => e !== "ANTHROPIC_KEY"))
		const dropped = await collectDetections(text, engine, new Set(["ANTHROPIC_KEY"]))
		expect(dropped.map((d) => d.entityType)).not.toContain("ANTHROPIC_KEY")
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

	it("absent key → tier-registry defaults, nothing disabled", () => {
		const config = getRedactionConfig()
		expect(config.resolved.engineExclusions).toEqual(getDefaultExcludedEntities())
		expect(config.resolved.disabledEntities.size).toBe(0)
		expect(config.resolved.customPatterns).toEqual([])
	})

	it("a present array replaces the defaults wholesale (raw list preserved)", () => {
		writeSettings({ excludedEntities: ["GUID"] })
		const config = getRedactionConfig()
		expect(config.resolved.engineExclusions).toEqual(["GUID"])
		expect(config.resolved.disabledEntities).toEqual(new Set(["GUID"]))
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
		expect(config.resolved.engineExclusions).toEqual(getDefaultExcludedEntities())
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

	describe("connection-string promotion (chunk 5)", () => {
		// A DSN without credentials is not a secret — must pass through intact.
		it("leaves credentialless database URIs untouched", async () => {
			for (const dsn of [
				"postgres://db.prod.internal:5432/telemetry",
				"mysql://db.internal:3306/app",
				"mongodb://mongo.internal:27017/analytics",
				"redis://cache.internal:6379",
				"amqp://rabbit.internal:5672",
				"mssql://sql.internal:1433;databaseName=app",
			]) {
				const out = await redactText(`dsn: ${dsn}`)
				expect(out, dsn).toContain(dsn)
			}
		})

		it("redacts only the userinfo of credential-bearing database URIs", async () => {
			const password = "sTr0ng" + "P4ss" + "w0rd" + "!9z"
			for (const scheme of ["postgres", "postgresql", "mysql", "mongodb", "amqp", "mssql"]) {
				const user = "svc_" + scheme
				const host = "db.intern" + "al:5432/app"
				const out = await redactText(`dsn: ${scheme}://${user}:${password}@${host}`)
				expect(out, scheme).toMatch(/\[REDACTED-(DATABASE_CONNECTION_STRING|URL_WITH_CREDENTIALS|EMAIL_ADDRESS)\]/)
				// label: engine EMAIL/URL claims win email-shaped userinfo spans before customs
				expect(out, scheme).not.toContain(password)
			}
		})

		it("redacts Azure connection-string secrets, value-only", async () => {
			const sasKey = "RW1iZWRkZWRTQVNLZXl" + "hYmNkZWYxMjM0NTY3ODkwQUJDREVGRw" + "="
			const out = await redactText(
				`sb: Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=${sasKey};`,
			)
			expect(out).toContain("[REDACTED-AZURE_CONNECTION_STRING]")
			expect(out).not.toContain(sasKey)
			expect(out).toContain("SharedAccessKeyName=RootManageSharedAccessKey") // identifier kept
		})

		it("leaves credentialless Azure connection strings untouched", async () => {
			const cs = "DefaultEndpointsProtocol=https;AccountName=prodcfg;EndpointSuffix=core.windows.net"
			expect(await redactText(`cs: ${cs}`)).toContain(cs)
			expect(await redactText("k: SharedAccessKeyName=RootManageSharedAccessKey")).toContain(
				"SharedAccessKeyName=RootManageSharedAccessKey",
			)
		})
	})

	it("splices by position: a password equal to the username does not survive (no substring replace)", () => {
		// Regression for the substring-replace bug: with user == pass, the
		// first occurrence of the secret text is inside the anchor, and the
		// old match.replace(secret, marker) marked the username while the
		// password passed through next to a redaction marker.
		const input = ["db at postgres", "ql://", "admin", ":", "admin", "@db.internal/app"].join("")
		const out = applyCustomPatterns(input, new Set())
		expect(out).not.toContain("admin") // neither user nor pass may survive
		expect(out).toContain("[REDACTED-DATABASE_CONNECTION_STRING]")
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
		// Okta tokens vary in length (SSWS-prefixed are 44) — the range must
		// tolerate short and long values behind the keyword.
		const okta = (n: number) => ["a", "0".repeat(n - 1)].join("")
		// Bare shapes survive (tier-registry default excludes them).
		const bare = `token blob ${tg} and ${okta(42)} tail`
		expect(await redactText(bare)).toBe(bare)
		// Keyword-anchored forms redact across the accepted length range.
		const anchored = await redactText(
			[
				"telegram_bot_token=",
				tg,
				" okta_token: ",
				okta(40),
				" okta_api_token=",
				okta(42),
				" okta_token: ",
				okta(44),
			].join(""),
		)
		expect(anchored).not.toContain(tg)
		expect(anchored).not.toContain(okta(40))
		expect(anchored).not.toContain(okta(42))
		expect(anchored).not.toContain(okta(44))
		expect(anchored).toContain("[REDACTED-TELEGRAM_BOT_TOKEN]")
		expect(anchored.split("[REDACTED-OKTA_TOKEN]").length - 1).toBe(3)
	})

	it("catches credential query parameters across separators and names", async () => {
		// `;`-delimited connection strings (Azure SAS) and extended names.
		const sas = ["SharedAccessSignature", "=sig=".slice(0, 4), "x".repeat(24)].join("")
		const out = await redactText(
			[
				"https://x.servicebus.windows.net/?",
				sas,
				"&refresh_token=",
				"r".repeat(24),
				";client_secret=",
				"c".repeat(24),
			].join(""),
		)
		expect(out).not.toContain("x".repeat(24))
		expect(out).not.toContain("r".repeat(24))
		expect(out).not.toContain("c".repeat(24))
		// SharedAccessSignature= is claimed by the AZURE_CONNECTION_STRING
		// custom; the other two stay URL_WITH_CREDENTIALS.
		expect(out.split("[REDACTED-URL_WITH_CREDENTIALS]").length - 1).toBe(2)
		expect(out.split("[REDACTED-AZURE_CONNECTION_STRING]").length - 1).toBe(1)
	})

	it("re-adds GENERIC_SECRET behind keyword:value pairs only", async () => {
		// Free-text secrets the JSON sensitive-key path cannot see.
		const secret = ["opaque-prox", "y-token-99"].join("")
		const anchored = await redactText(`the api_secret: ${secret} was rotated`)
		expect(anchored).not.toContain(secret)
		expect(anchored).toContain("[REDACTED-GENERIC_SECRET]")
		// A 16+ run without a keyword passes (bare-shape precision).
		const bare = `blob ${secret} tail`
		expect(await redactText(bare)).toBe(bare)
	})

	it("rejects keyword-shaped identifier suffixes as GENERIC_SECRET anchors", async () => {
		// The keyword must stand alone — inside a camelCase identifier it is not
		// a keyword (`oauthAccessToken = …`, measured FP class).
		const fixture = "c" + "zk7dj39sl4kf8tn2qp0a5wbxreu"
		const assignment = `oauthAccessToken = "${fixture}"`
		expect(await redactText(assignment)).toBe(assignment)
		// The same value behind a real keyword still redacts.
		const positive = await redactText(`token: ${fixture}`)
		expect(positive).not.toContain(fixture)
		expect(positive).toContain("[REDACTED-GENERIC_SECRET]")
	})

	it("keeps redacting SNAKE_CASE env keys and dashed CLI flags", async () => {
		// `_` / `-` are keyword boundaries, not identifier chars: MY_TOKEN=…
		// and --token=… are real secret habitats (contracts-001 fix).
		const secret = ["s", "c9f2b7a1d3e5f7a9c1b3d5e7f9a1c3e5"].join("")
		const envLine = `MY_TOKEN=${secret}`
		const env = await redactText(envLine)
		expect(env).not.toContain(secret)
		expect(env).toContain("[REDACTED-GENERIC_SECRET]")
		const flag = await redactText(`run --token=${secret} now`)
		expect(flag).not.toContain(secret)
		expect(flag).toContain("[REDACTED-GENERIC_SECRET]")
		expect(flag).toContain("--token=")
	})

	it("re-adds DOCKER_REGISTRY_AUTH from the config's JSON auth key", async () => {
		const creds = Buffer.from("svc:p4ssw0rd99").toString("base64")
		const result = await redactText(`docker config {"auth": "${creds}"}`)
		expect(result).not.toContain(creds)
		expect(result).toContain("[REDACTED-DOCKER_REGISTRY_AUTH]")
	})

	it("force-redacts string values under an 'auth' JSON key", async () => {
		const result = await redactObjectStrings({ auth: "opaque-proxy-token-99" })
		expect(result).toEqual({ auth: "[REDACTED-SECRET_FIELD]" })
		// Object-valued auth stays structural (OAuth configs).
		const nested = await redactObjectStrings({ auth: { url: "https://sso.example.com" } })
		expect(nested).toEqual({ auth: { url: "https://sso.example.com" } })
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

	it("a broken local settings file does not knock out the org's own rules", async () => {
		await setOrgPolicyForTests({ redaction: { categories: { emails: "KIMCHI_REDACTION_STATE_OFF" } } })
		writeSettings({ excludedEntities: ["SSN"] }) // unknown: real name is US_SSN
		resetRedactorEngine()
		const result = await redactText(`mail ${fx.email}`)
		// The org said emails pass through; a local typo it did not write
		// must not silently re-enable them in the degraded snapshot.
		expect(result).toContain(fx.email)
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
describe("redactObjectStringsMeasured — redaction + privacy-safe report", () => {
	beforeEach(() => {
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})
	afterEach(() => {
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})

	it("redaction output matches the unmeasured variant and tallies entity types", async () => {
		const input = {
			note: "Contact john.doe@example.com or jane.doe@example.com",
			cicdEnv: "GITHUB_TOKEN=ghp_1234567890abcdef1234567890abcdef12",
		}
		const [{ redacted, report }, unmeasured] = await Promise.all([
			redactObjectStringsMeasured(structuredClone(input)),
			redactObjectStrings(structuredClone(input)),
		])

		expect(redacted).toEqual(unmeasured)
		// Since #1626 the engine labels ghp_ tokens as GITHUB_TOKEN directly
		// (previously the generic CRYPTO high-entropy marker) — the tally
		// reflects the markers in the redacted output, not the producer.
		expect(report.entities).toEqual({ EMAIL_ADDRESS: 2, GITHUB_TOKEN: 1 })
		expect(report.stringsScanned).toBe(2)
		expect(report.engineFailures).toBe(0)
		// The report is tallied from the redacted output — it can never
		// contain the raw values.
		const serialized = JSON.stringify(report)
		expect(serialized).not.toContain("john.doe@example.com")
		expect(serialized).not.toContain("ghp_")
	})

	it("counts sensitive-key force-redactions as SECRET_FIELD without scanning them", async () => {
		const { report, redacted } = await redactObjectStringsMeasured({
			data: { apiKey: "sk-abcdef123456", note: "email john.doe@example.com" },
		})
		expect(redacted.data.apiKey).toBe("[REDACTED-SECRET_FIELD]")
		expect(report.entities).toEqual({ SECRET_FIELD: 1, EMAIL_ADDRESS: 1 })
		// Force-redacted values bypass the engine scan; only the note was scanned.
		expect(report.stringsScanned).toBe(1)
	})

	it("preserved keys (trace IDs) survive and are neither scanned nor tallied", async () => {
		const { report, redacted } = await redactObjectStringsMeasured({
			data: { traceIds: ["abc123", "def456"], email: "john.doe@example.com" },
		})
		expect(redacted.data.traceIds).toEqual(["abc123", "def456"])
		expect(report.entities).toEqual({ EMAIL_ADDRESS: 1 })
	})

	it("fail-open still returns the original text and counts the engine failure", async () => {
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const input = { nested: { content: "call me at john.doe@example.com" } }
		const { redacted, report } = await redactObjectStringsMeasured(input)
		expect(redacted.nested.content).toBe("call me at john.doe@example.com")
		expect(report.engineFailures).toBe(1)
		expect(report.stringsScanned).toBe(1)
		expect(report.entities).toEqual({})
		errSpy.mockRestore()
	})

	// A persistently degraded engine must not flood stderr with one stack
	// trace per scanned string — the report's failure count is the signal,
	// the log is once per invocation.
	it("logs the first engine failure per invocation, however many strings fail", async () => {
		engineScanOverride.scanImpl = () => Promise.reject(new Error("engine exploded"))
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { report } = await redactObjectStringsMeasured({ a: "one longer string", b: "two", c: "three and more" })
		expect(report.engineFailures).toBe(3)
		expect(errSpy).toHaveBeenCalledTimes(1)
		errSpy.mockRestore()
	})

	it("empty report for clean input — no markers, no scans beyond the walk", async () => {
		const { report } = await redactObjectStringsMeasured({ plain: "nothing sensitive here" })
		expect(report.entities).toEqual({})
		expect(report.engineFailures).toBe(0)
		expect(report.stringsScanned).toBe(1)
	})

	// Regression: real messages carry content as an ARRAY of blocks
	// ({role, content: [{type:"text",text}]}) — the observer that tallies
	// markers must be forwarded through the array branch of the walker, or
	// redactions deep in real message trees are applied but never counted.
	it("tallies entity types inside array-shaped message content", async () => {
		const card = ["4532", "0151", "1283", "0366"].join("") // Luhn-valid
		const message = {
			role: "user",
			content: [{ type: "text", text: `Contact john.doe@example.com about invoice CC: ${card}` }],
		}
		const { redacted, report } = await redactObjectStringsMeasured(structuredClone(message))
		expect(redacted.content[0]?.text).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(report.entities).toEqual({ EMAIL_ADDRESS: 1, CREDIT_CARD: 1 })
	})

	// Regression for the double-report failure mode: message_end scrubs the
	// user message before before_provider_request re-scans it — the second
	// pass must not tally the markers it did not introduce.
	it("a re-scan of previously redacted text tallies no new redactions", async () => {
		const first = await redactObjectStringsMeasured({ content: "Contact john.doe@example.com" })
		expect(first.report.entities).toEqual({ EMAIL_ADDRESS: 1 })

		const second = await redactObjectStringsMeasured(structuredClone(first.redacted))
		expect(second.report.entities).toEqual({})
		expect(second.redacted).toEqual(first.redacted)
	})
})

describe("scan settle bound — in-flight map must always release", () => {
	beforeEach(() => {
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})
	afterEach(() => {
		vi.useRealTimers()
		resetRedactorEngine()
		engineScanOverride.scanImpl = null
	})

	// A scan promise that never settles would keep the hooks' strong-keyed
	// in-flight entry (and the unredacted message) pinned for the process
	// lifetime. The settle bound treats it as an engine failure: fail-open
	// original text, counted and logged once per invocation.
	it("fails open (counted, logged once) when the engine scan never settles", async () => {
		vi.useFakeTimers()
		engineScanOverride.scanImpl = () => new Promise(() => {})
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const pending = redactObjectStringsMeasured({ content: "anything at all" })
		await vi.advanceTimersByTimeAsync(30_000)
		const { redacted, report } = await pending

		expect(redacted.content).toBe("anything at all")
		expect(report.engineFailures).toBe(1)
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(String(consoleErrorSpy.mock.calls[0]?.[1])).toContain("did not settle")
		consoleErrorSpy.mockRestore()
	})
})

// ─── Precision defaults — detections that identify nobody ───────────────────
//
// Two tables: every measured false-positive family must be filtered, and a
// true-positive guard must survive for each rule. The guards matter more than
// the filters — two candidate rules were rejected during design for dropping
// real data (rejecting `.internal`/`.local` by domain, and treating whitespace
// or punctuation as "code"), so they are pinned here as regressions.

describe("precision defaults — measured false-positive families", () => {
	it.each([
		// Versioned package paths read as addresses (the `patches/@scope__pkg@x.y.z.patch` shape).
		["toolchain@v0.0.1-go1.26.5.darwin", "go version string"],
		["earendil-works__pi-coding-agent@1.3.0.patch", "patchedDependencies path"],
		["pi-agent-core@0.85.1.patch", "bare package path"],
		["lib@5.3.1.path", "path-shaped suffix"],
		["pkg@2.34.0.patch", "versioned patch file"],
		// The harness's own commit identity.
		["noreply@kimchi.dev", "self identity"],
		// Role mailboxes.
		["git@github.com", "git role address"],
		["noreply@acmecorp.com", "noreply role address"],
		["bot+notifications@acmecorp.com", "tagged role address"],
		["mailer-daemon@acmecorp.com", "bounce address"],
	])("drops %s (%s)", (span) => {
		expect(isNonIdentifyingEmail(span)).toBe(true)
		expect(isNonIdentifyingDetection("EMAIL_ADDRESS", span)).toBe(true)
	})

	it.each([
		["127.0.0.1", "loopback"],
		["127.4.5.6", "loopback /8"],
		["0.0.0.0", "this network"],
		["169.254.10.1", "link-local"],
		["192.0.2.7", "TEST-NET-1"],
		["198.51.100.7", "TEST-NET-2"],
		["203.0.113.7", "TEST-NET-3"],
		["198.18.0.1", "benchmarking"],
		["::1", "ipv6 loopback"],
		["fe80::1", "ipv6 link-local"],
		["2001:db8::", "ipv6 documentation prefix"],
		["2001:db8::1", "ipv6 documentation address"],
		// Prefix-only fragments are not addresses.
		["DB::", "ClickHouse scope marker"],
		["0136::", "Go module version in scoped path"],
		["127::", "unknown-protocol scope fragment"],
		["fc00::", "bare ULA network prefix"],
	])("drops %s (%s)", (span) => {
		expect(isNonSensitiveIp(span)).toBe(true)
		expect(isNonIdentifyingDetection("IP_ADDRESS", span)).toBe(true)
	})
})

describe("precision defaults — true-positive guards", () => {
	it.each([
		// Real people at real domains, including the git-trailer population.
		["jane.doe@acmecorp.com", "personal address"],
		["jane.doe@gmail.com", "consumer address"],
		["jane.doe@cast.ai", "short gTLD"],
		// A real intranet address: rejecting `.internal` by domain would leak it.
		["john.doe@corp.internal", "intranet address"],
		// A real mDNS hostname: rejecting `.local` by domain would leak it.
		["theo.martin@theos-macbook-pro.local", "mdns address"],
		// Real TLDs that look like file extensions — the reason this is not a suffix deny-list.
		["someone@example.zip", ".zip is a real gTLD"],
		["someone@corp.sh", ".sh is a real ccTLD"],
		["someone@corp.md", ".md is a real ccTLD"],
		// Reserved namespaces stay redacted on purpose (fixture semantics).
		["jane.doe@example.com", "reserved but intentionally redacted"],
		// Consumer mail providers with a numeric label — a real person's mailbox.
		["zhang.wei@163.com", "163.com is NetEase mail"],
		["someone@126.com", "126.com is NetEase mail"],
		["user@189.com.cn", "numeric label in a multi-label domain"],
		// Raw-Unicode IDN domains are real addresses (engine support is ASCII-only
		// today; this must stay redacted if that changes).
		["user@пример.рф", "raw Unicode .рф"],
		["user@みんな.メール", "raw Unicode IDN"],
		// Mixed case must not be misread as a package path.
		["jane.doe@Corp.COM", "mixed-case domain"],
		// A trailing dot is a valid absolute FQDN, not a file extension.
		["jane.doe@acmecorp.com.", "trailing-dot FQDN"],
		// A personal plus-tag carries an identifier; only operational tags are ignored.
		["noreply+jane.doe@acmecorp.com", "personal plus-tag on a role base"],
		// Punycode TLDs are real.
		["user@example.xn--p1ai", "punycode .рф"],
		["user@xn--80akhbyknj4f.xn--p1ai", "fully punycode IDN"],
		// Digits in a label are fine as long as the label is not purely numeric.
		["user@mail.1und1.de", "digit-leading but real label"],
	])("keeps %s (%s)", (span) => {
		expect(isNonIdentifyingEmail(span)).toBe(false)
		expect(isNonIdentifyingDetection("EMAIL_ADDRESS", span)).toBe(false)
	})

	it.each([
		["93.184.216.34", "public endpoint"],
		["8.8.8.8", "public resolver"],
		// Private space still describes real internal topology — kept redacted.
		["10.0.0.5", "RFC1918 /8"],
		["192.168.1.10", "RFC1918 /16"],
		["172.16.5.4", "RFC1918 /12"],
		["fc00::1", "ipv6 ULA"],
		["2607::", "routable global-unicast base (security-003)"],
		["2a00::", "RIPE global-unicast base (security-003)"],
		["fd12::", "ULA /48 base (security-003)"],
		["2001:4860:4860::8888", "global IPv6 (must not be caught by the db8 rule)"],
	])("keeps %s (%s)", (span) => {
		expect(isNonSensitiveIp(span)).toBe(false)
		expect(isNonIdentifyingDetection("IP_ADDRESS", span)).toBe(false)
	})
})

describe("base64-shadow suppression", () => {
	const fbShape = () => ["EAAC", "g".repeat(80)].join("")

	it("drops base64-shadow-prone entities embedded in an entropy block", () => {
		const token = fbShape()
		const text = `iVBORw0KGgo${token}+`
		const start = text.indexOf(token)
		expect(isBase64ShadowDrop("FACEBOOK_TOKEN", text, start, start + token.length)).toBe(true)
	})

	it.each([
		"FACEBOOK_TOKEN",
		"AIRTABLE_KEY",
		"TWITTER_BEARER_TOKEN",
		"CRATES_IO_TOKEN",
		"NUGET_KEY",
		"SQUARE_ACCESS_TOKEN",
		"ALIBABA_CLOUD_KEY",
		"GCP_API_KEY",
	])("applies to %s", (entity) => {
		const text = `q+${"a".repeat(60)}/w`
		expect(isBase64ShadowDrop(entity, text, 2, 62)).toBe(true)
	})

	it("fails toward redaction: edges, unknown entities, non-base64 neighbor", () => {
		const token = fbShape()
		// String edges have no neighbor to prove embedding.
		expect(isBase64ShadowDrop("FACEBOOK_TOKEN", token, 0, token.length)).toBe(false)
		// Unknown entity types are never filtered.
		expect(isBase64ShadowDrop("OPENAI_KEY", `q${token}w`, 1, 1 + token.length)).toBe(false)
		// One delimiting neighbor is enough to keep the span.
		expect(isBase64ShadowDrop("FACEBOOK_TOKEN", `${token},`, 0, token.length)).toBe(false)
		expect(isBase64ShadowDrop("FACEBOOK_TOKEN", `"${token}"`, 1, 1 + token.length)).toBe(false)
	})

	it("pipeline: base64-embedded keyword-anchored runs pass through, delimited ones redact", async () => {
		// The engine's FACEBOOK_TOKEN shape is keyword-anchored; embedded
		// occurrences in base64 payloads are the measured FP class.
		const token = ["EAAC", "g".repeat(60)].join("")
		// The engine value regex greedily swallows trailing base64 chars into
		// the span; base64 padding (`=`) breaks the run, as in real payloads.
		const kw = "FACEB" + "OOK_TOKEN="
		const embedded = `data:image/png;base64,iVBORw0KGgo${kw}${token}SUQmCC==`
		expect(await redactText(embedded)).toBe(embedded)
		const delimited = await redactText(`FACEBOOK_TOKEN="${token}"`)
		expect(delimited).not.toContain(token)
		expect(delimited).toContain("[REDACTED-FACEBOOK_TOKEN]")
	})

	it("over-length vendor keys in ordinary assignments still redact (security-002)", async () => {
		// Engine spans are length-capped (LTAI{12,20}): past the cap the
		// end-neighbor is alphanumeric — truncation, not entropy embedding.
		const longKey = "LTAI" + "aB3dE6gH9jK2mN5pQ8sT1v2W4yZ6"
		const result = await redactText(`ACCESS_KEY_ID=${longKey}`)
		expect(result).not.toContain(longKey)
		expect(result).toContain("[REDACTED-ALIBABA_CLOUD_KEY]")
	})

	it("shadow-entity keys in prose, URL paths, and marker-laden strings stay redacted", async () => {
		const gcp = "AIza" + "SyD4kN8pQr2tW5xZ9bC1eF3hJ6mL0nP4qR7sT5u"
		const prose = await redactText(`the gcp key ${gcp} leaked`)
		expect(prose).not.toContain(gcp)
		expect(prose).toContain("[REDACTED-GCP_API_KEY]")
		// A URL path separator is not base64 evidence (correctness-003).
		const url = "https://example.com/v1/" + gcp + "/resource"
		const apiCall = await redactText(`curl ${url}`)
		expect(apiCall).not.toContain(gcp)
		// Marker text breaks base64 runs: fixture strings keep redacting.
		const laden = `[REDACTED-GCP_API_KEY]iVBORw0KGgo${gcp}SUQmCC==`
		const twice = await redactText(laden)
		expect(twice).not.toContain(gcp)
	})
})

describe("precision defaults — scope guards", () => {
	it("never drops an unknown entity type", () => {
		// Fail toward redaction: a new detector's output is never filtered blind.
		expect(isNonIdentifyingDetection("AWS_SECRET_KEY", "noreply@kimchi.dev")).toBe(false)
		expect(isNonIdentifyingDetection("SOMETHING_NEW", "127.0.0.1")).toBe(false)
	})

	it("keeps a span it cannot parse — the engine already called it an address", () => {
		// Failure direction is toward redaction: unparseable is not evidence of
		// non-identification.
		expect(isNonIdentifyingEmail("not-an-address")).toBe(false)
		expect(isNonIdentifyingEmail("@")).toBe(false)
	})

	it("keeps single-label (dotless) domains — they are real intranet hosts", () => {
		expect(isNonIdentifyingEmail("jane.doe@intranet")).toBe(false)
		expect(isNonIdentifyingEmail("user@mailserver")).toBe(false)
		expect(isTechnicalEmailDomain("intranet")).toBe(false)
	})

	it("matches self identity exactly, never by domain", () => {
		expect(isSelfIdentity("noreply@kimchi.dev")).toBe(true)
		expect(isSelfIdentity("Noreply@Kimchi.Dev")).toBe(true)
		// A real employee address must still be redacted.
		expect(isSelfIdentity("jane.doe@kimchi.dev")).toBe(false)
		expect(isNonIdentifyingEmail("jane.doe@kimchi.dev")).toBe(false)
	})

	it("rejects non-TLD suffixes and double-underscore scopes", () => {
		expect(isTechnicalEmailDomain("1.3.0.patch")).toBe(true)
		expect(isTechnicalEmailDomain("v0.0.1-go1.26.5.darwin")).toBe(true)
		expect(isTechnicalEmailDomain("scope__pkg")).toBe(true)
		expect(isTechnicalEmailDomain("acmecorp.com")).toBe(false)
	})

	it("recognises tagged role addresses only when the tag is operational", () => {
		expect(isGenericLocalPart("noreply+notifications")).toBe(true)
		expect(isGenericLocalPart("bot+123")).toBe(true)
		expect(isGenericLocalPart("noreply")).toBe(true)
		// A tag can carry an identifier — keep redacted.
		expect(isGenericLocalPart("noreply+jane.doe")).toBe(false)
		expect(isGenericLocalPart("git+ssh-key")).toBe(false)
		expect(isGenericLocalPart("jane.doe")).toBe(false)
	})

	it("normalises case before classifying a domain", () => {
		expect(isTechnicalEmailDomain("Corp.COM")).toBe(false)
		expect(isTechnicalEmailDomain("ACME.COM")).toBe(false)
		// Version shapes are still caught regardless of case.
		expect(isTechnicalEmailDomain("1.3.0.PATCH")).toBe(true)
	})

	it("treats an empty final label as non-technical", () => {
		expect(isTechnicalEmailDomain("acmecorp.com.")).toBe(false)
	})

	it("treats Unicode and punycode TLDs as real", () => {
		expect(isTechnicalEmailDomain("пример.рф")).toBe(false)
		expect(isTechnicalEmailDomain("example.xn--p1ai")).toBe(false)
	})
})

describe("getRedactionConfig — redaction.renderMode settings", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-render-"))
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

	it("absent key → tokens", () => {
		expect(getRedactionConfig().renderMode).toBe("tokens")
	})

	it('"tokens" parses', () => {
		writeSettings({ renderMode: "tokens" })
		expect(getRedactionConfig().renderMode).toBe("tokens")
	})

	it('"markers" parses explicitly', () => {
		writeSettings({ renderMode: "markers" })
		expect(getRedactionConfig().renderMode).toBe("markers")
	})

	it("invalid values throw (fail-visible)", () => {
		writeSettings({ renderMode: "cloaked" })
		expect(() => getRedactionConfig()).toThrow(/renderMode/)
	})

	it("non-string values throw", () => {
		writeSettings({ renderMode: 2 })
		expect(() => getRedactionConfig()).toThrow(/renderMode/)
	})

	it("FORCE locks follow the tokens default — the org lock pins the resource, not the presentation", async () => {
		// A local settings override (including markers) is never read under a
		// lock: the deployment renders the default in every case.
		writeSettings({ renderMode: "markers" })
		await setOrgPolicyForTests({ resources: { [PII_REDACTION_RESOURCE_ID]: "FORCE_ON" } })
		expect(getRedactionConfig().renderMode).toBe("tokens")
	})
})

describe("token mode — composition and tally parity", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-token-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
		resetTokenVaults()
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

	it("identifier entities render as stable tokens; secret classes stay markers", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const vault = createTokenVault()
		const first = await redactObjectStringsMeasured(
			{ a: `mail ${fx.email}`, b: `host ${fx.ipAddress}`, c: `bearer ${fx.bearerValue}` },
			vault,
		)
		const out = JSON.stringify(first.redacted)
		expect(out).toContain("[EMAIL_ADDRESS_1]")
		expect(out).toContain("[IP_ADDRESS_1]")
		expect(out).toContain("[REDACTED-BEARER_TOKEN]")
		expect(out).not.toContain(fx.email)
		expect(out).not.toContain(fx.ipAddress)
		expect(out).not.toContain(fx.bearerValue)
		// Stability: the same address in a second pass reuses the token.
		const second = await redactObjectStringsMeasured({ d: `again ${fx.email}` }, vault)
		expect(JSON.stringify(second.redacted)).toContain("[EMAIL_ADDRESS_1]")
		// A distinct address allocates the next counter.
		const other = await redactObjectStringsMeasured({ e: `ping ${["robin.hood", "corp-mail.io"].join("@")}` }, vault)
		expect(JSON.stringify(other.redacted)).toContain("[EMAIL_ADDRESS_2]")
		// Round-trip: presentation-side substitution recovers the originals
		// from tokens; markers are untouched by substitution.
		expect(substituteTokens(vault, JSON.stringify(first.redacted))).toContain(fx.email)
		expect(substituteTokens(vault, "[REDACTED-BEARER_TOKEN]")).toBe("[REDACTED-BEARER_TOKEN]")
	})

	it("engine detections outside the token set stay marker-shaped in token mode", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const result = await redactObjectStringsMeasured({ cc: `card ${fx.creditCard}` }, createTokenVault())
		expect(JSON.stringify(result.redacted)).toContain("[REDACTED-CREDIT_CARD]")
	})

	it("a missing vault under token settings falls back to markers", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const result = await redactObjectStringsMeasured({ a: `mail ${fx.email}` })
		expect(JSON.stringify(result.redacted)).toContain("[REDACTED-EMAIL_ADDRESS]")
	})

	it("tokens are the default mode (no renderMode key)", async () => {
		const result = await redactObjectStringsMeasured({ a: `mail ${fx.email}` }, createTokenVault())
		expect(JSON.stringify(result.redacted)).toContain("[EMAIL_ADDRESS_1]")
	})

	it("tally parity: identical input reports identical entities in both modes", async () => {
		const input = {
			a: `mail ${fx.email}`,
			b: `second ${["robin.hood", "corp-mail.io"].join("@")} host ${fx.ipAddress}`,
		}
		writeSettings({ renderMode: "markers" })
		const markerRun = await redactObjectStringsMeasured(structuredClone(input))
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const tokenRun = await redactObjectStringsMeasured(structuredClone(input), createTokenVault())
		expect(tokenRun.report.entities).toEqual(markerRun.report.entities)
		expect(Object.keys(tokenRun.report.entities).length).toBeGreaterThan(0)
	})

	it("a re-scan of already-tokenized text nets to zero introduced redactions", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const vault = createTokenVault()
		const first = await redactObjectStringsMeasured({ a: `mail ${fx.email}` }, vault)
		const second = await redactObjectStringsMeasured(first.redacted, vault)
		expect(second.report.entities).toEqual({})
	})

	it("a token in the input can never be re-consumed by the custom-pattern pass", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const vault = createTokenVault()
		// GENERIC_SECRET's value charset excludes `[`/`]`, so the composed
		// token must survive the second pass verbatim.
		const result = await redactObjectStringsMeasured(
			{ a: `password: somelongsecretvalue123 and mail ${fx.email}` },
			vault,
		)
		expect(JSON.stringify(result.redacted)).toContain("[EMAIL_ADDRESS_1]")
	})

	it("strict export stays markers under token-mode settings", async () => {
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const result = await redactObjectStringsStrict({ a: `mail ${fx.email}` })
		expect(JSON.stringify(result)).toContain("[REDACTED-EMAIL_ADDRESS]")
	})

	it("strict export converts tokens already stored in the input to markers (exports leak nothing reversible)", async () => {
		// The export walk starts from STORED session entries, which token mode
		// keeps tokenized — a strict pass over those strings used to ship the
		// token (and implicitly the vault-resolvable original) out the door.
		writeSettings({ renderMode: "tokens" })
		resetRedactorEngine()
		const vault = createTokenVault()
		const stored = await redactObjectStringsMeasured({ a: `mail ${fx.email}` }, vault)
		expect(JSON.stringify(stored.redacted)).toContain("[EMAIL_ADDRESS_1]")
		const exported = await redactObjectStringsStrict(stored.redacted)
		expect(JSON.stringify(exported)).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(JSON.stringify(exported)).not.toContain("[EMAIL_ADDRESS_1]")
	})

	it("excluded entities drop detections in token mode exactly as in marker mode", async () => {
		writeSettings({ renderMode: "tokens", excludedEntities: [...getDefaultExcludedEntities(), "EMAIL_ADDRESS"] })
		resetRedactorEngine()
		const result = await redactObjectStringsMeasured({ a: `mail ${fx.email}` }, createTokenVault())
		expect(JSON.stringify(result.redacted)).toContain(fx.email)
		expect(result.report.entities).toEqual({})
	})
})

describe("redactObjectStrings — image payloads are binary, not text", () => {
	// Real-session shape: base64 of an ordinary PNG happened to contain a run
	// matching an api-key pattern. Replacing it corrupted the image,
	// and the provider rejected every later turn with a 400.
	// tokenShaped: redactable fixture (Anthropic sk-ant shape) for the "still
	// scans" cases — default-on, so the fixture asserts pipeline behavior, not
	// an opt-in entity (Airtable was demoted to opt-in at measured ~3% precision).
	// blobTokenShaped: crates.io shape — anchor-required (never fires) since the
	// byte-identical cases assert the payload bypass, not entity detection; the
	// pure-base64-alphabet shape keeps payload alignment semantics intact.
	const tokenShaped = ["sk-ant-", "aB3dE6gH9jK2mN"].join("")
	const blobTokenShaped = ["cio", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF"].join("")
	const base64 = `iVBORw0KGgoA/+${blobTokenShaped}/+AAAAElFTkSuQmCC==`
	const fromBytes = (head: string) =>
		`${Buffer.from(head, "latin1").toString("base64")}${blobTokenShaped}A`.padEnd(64, "A")
	// A break inside the first 16 base64 chars shrinks the signature window.
	const breakInSignature = (head: string) => {
		const raw = `${Buffer.from(head, "latin1").toString("base64")}${blobTokenShaped}A`.padEnd(64, "A")
		return `${raw.slice(0, 8)}\n${raw.slice(8)}`
	}

	it.each([
		["internal image block", { type: "image", mimeType: "image/png", data: base64 }],
		["Anthropic source block", { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
		["Google inlineData part", { inlineData: { mimeType: "image/png", data: base64 } }],
		["OpenAI image_url part", { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }],
		["OpenAI Responses input_image part", { type: "input_image", image_url: `data:image/png;base64,${base64}` }],
		["Mistral imageUrl part", { type: "image_url", imageUrl: `data:image/png;base64,${base64}` }],
		["base64 with a trailing newline", { mimeType: "image/png", data: `${base64}\n` }],
		["line-wrapped base64", { mimeType: "image/png", data: `${base64.slice(0, 60)}\r\n${base64.slice(60)}` }],
		["data URL with parameters", { image_url: { url: `data:image/png;name=a.png;base64,${base64}` } }],
		["data URL from a parameterised mime type", { image_url: { url: `data:image/png; charset=x;base64,${base64}` } }],
		["JPEG bytes", { mimeType: "image/jpeg", data: fromBytes("\xff\xd8\xff") }],
		["GIF bytes", { mimeType: "image/gif", data: fromBytes("GIF89a") }],
		["WebP bytes", { mimeType: "image/webp", data: fromBytes("RIFF\x10\0\0\0WEBP") }],
		[
			"WebP with a break inside its signature",
			{ mimeType: "image/webp", data: breakInSignature("RIFF\x10\0\0\0WEBP") },
		],
		[
			"data URL with a long name parameter",
			{ image_url: { url: `data:image/png;name=${"a".repeat(200)};base64,${base64}` } },
		],
		["image data URL in an array under image_url", { image_url: [{ url: `data:image/png;base64,${base64}` }] }],
	])("leaves %s byte-identical", async (_name, block) => {
		expect(await redactObjectStrings({ role: "user", content: [block] })).toEqual({ role: "user", content: [block] })
	})

	it.each([
		["data field without an image mime type", { mimeType: "text/plain", data: tokenShaped }],
		["image block whose data is not base64", { mimeType: "image/png", data: `note: ${tokenShaped}` }],
		["data URL with text after the payload", { image_url: { url: `data:image/png;base64,AAAA ${tokenShaped}` } }],
		["non-image data URL", { image_url: { url: `data:text/plain;base64,${tokenShaped}` } }],
		["bare secret labelled as an image", { mimeType: "image/png", data: tokenShaped }],
		["bare secret with an empty image subtype", { mimeType: "image/", data: tokenShaped }],
		["image-labelled data of an invalid base64 length", { mimeType: "image/png", data: `iVBORw0KGgo ${tokenShaped}A` }],
		["image data URL whose bytes are not an image", { image_url: { url: `data:image/png;base64,${tokenShaped}A` } }],
	])("still scans %s", async (_name, block) => {
		expect(JSON.stringify(await redactObjectStrings(block))).toContain("[REDACTED-ANTHROPIC_KEY]")
	})

	it.each([
		["image data URL inside a text block", { type: "text", text: `data:image/png;base64,${base64}` }],
		["image data URL as a tool argument", { command: `data:image/png;base64,${base64}` }],
		["image data URL under a generic url key", { url: `data:image/png;base64,${base64}` }],
	])("base64-embedded token shapes in %s pass through unmodified", async (_name, block) => {
		// The shadow-entity match inside an entropy block is payload noise —
		// splicing a marker into base64 corrupts the image (the provider 400
		// bug documented above). Scanning stays on: the grid above redacts
		// genuinely delimited secrets in these same contexts.
		expect(await redactObjectStrings(block)).toEqual(block)
	})

	it("passes a bare top-level image data URL through byte-identical", async () => {
		expect(await redactObjectStrings(`data:image/png;base64,${base64}`)).toBe(`data:image/png;base64,${base64}`)
	})

	it("keeps Bedrock's binary image bytes as a typed array", async () => {
		const bytes = new Uint8Array([137, 80, 78, 71])
		const out = await redactObjectStrings({ image: { format: "png", source: { bytes } } })
		expect(out.image.source.bytes).toBeInstanceOf(Uint8Array)
		expect(out.image.source.bytes).toEqual(bytes)
	})
})

describe("redaction policy — categories/entities/customEntities settings", () => {
	let codingAgentDir: string

	beforeEach(() => {
		codingAgentDir = mkdtempSync(join(tmpdir(), "kimchi-redact-policy-"))
		vi.stubEnv("KIMCHI_CODING_AGENT_DIR", codingAgentDir)
		vi.stubEnv("KIMCHI_ENABLE_RESOURCES", "")
		resetRedactorEngine()
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

	it("unknown key inside the redaction section throws (fail-visible)", () => {
		writeSettings({ categoriis: { secrets: "off" } })
		expect(() => getRedactionConfig()).toThrow(/unknown property/)
	})

	it("entity OFF passes that type through; other types still redact", async () => {
		writeSettings({ entities: { EMAIL_ADDRESS: "off" } })
		resetRedactorEngine()
		const result = await redactTextOrThrow(`Contact ${fx.email} CC: ${fx.creditCard}`)
		expect(result).toContain(fx.email)
		expect(result).not.toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result).toContain("[REDACTED-CREDIT_CARD]")
	})

	it("category OFF secrets passes tokens, anchored secrets, and SECRET_FIELD through", async () => {
		const secret = ["opaque-prox", "y-token-99"].join("")
		writeSettings({ categories: { secrets: "off" } })
		resetRedactorEngine()

		for (const input of [
			`Token ${fx.ghpToken} leaked`,
			`key ${fx.castaiKey} here`,
			["the api_secret: ", secret].join(""),
		]) {
			expect(await redactTextOrThrow(input)).toBe(input)
		}
		// SECRET_FIELD is a secrets member: the JSON-key force-redaction stops.
		expect(await redactObjectStrings({ password: "abc" + "123" })).toEqual({ password: "abc123" })
		// Other categories untouched.
		const other = await redactTextOrThrow(`CC: ${fx.creditCard} config at ${fx.localPath}`)
		expect(other).toContain("[REDACTED-CREDIT_CARD]")
		expect(other).toContain("[REDACTED-LOCAL_PATH]")
	})

	it("entity ON redacts a bare-shape type (PHONE_NUMBER)", async () => {
		writeSettings({ entities: { PHONE_NUMBER: "on" } })
		resetRedactorEngine()
		const result = await redactTextOrThrow(`Call ${fx.phone} to reach support`)
		expectRedacted(result, fx.phone, "PHONE_NUMBER")
	})

	it("entity ON keeps an anchor-required bare shape off, anchored forms covered", async () => {
		writeSettings({ entities: { AWS_SECRET_KEY: "on" } })
		resetRedactorEngine()
		const bare = `replica sharer ${fx.awsSecret} tail`
		expect(await redactTextOrThrow(bare)).toBe(bare)
		const anchored = await redactTextOrThrow(`aws_secret_access_key= "${fx.awsSecret}"`)
		expectRedacted(anchored, fx.awsSecret, "AWS_SECRET_KEY")
	})

	it("custom entities redact their capture group and attribute their category", async () => {
		writeSettings({
			customEntities: [
				{
					name: "ACME_EMPLOYEE_ID",
					category: "identity_documents",
					pattern: "(emp[-_ ]?id\\s*[:=]\\s*)(E\\d{6})",
					flags: "i",
					secretGroup: 2,
				},
			],
		})
		resetRedactorEngine()
		const { redacted, report } = await redactObjectStringsMeasured({ note: "assigned to emp id: E123456 today" })
		expect(redacted).toEqual({ note: "assigned to emp id: [REDACTED-ACME_EMPLOYEE_ID] today" })
		expect(report.entities).toEqual({ ACME_EMPLOYEE_ID: 1 })
		expect(report.categories).toEqual({ ACME_EMPLOYEE_ID: "identity_documents" })
	})

	it("custom entities honor the OFF state (entity and category level)", async () => {
		writeSettings({
			customEntities: [{ name: "ACME_EMPLOYEE_ID", category: "identity_documents", pattern: "E\\d{6}" }],
			entities: { ACME_EMPLOYEE_ID: "off" },
		})
		resetRedactorEngine()
		const input = "assigned to E123456"
		expect(await redactTextOrThrow(input)).toBe(input)
	})

	it("mixing legacy excludedEntities with the policy keys throws (fail-visible)", () => {
		writeSettings({ excludedEntities: ["GUID"], categories: { secrets: "off" } })
		expect(() => getRedactionConfig()).toThrow(/cannot be combined/)
	})

	it("mid-session edits rebuild the engine without restart", async () => {
		writeSettings({ entities: { EMAIL_ADDRESS: "off" } })
		resetRedactorEngine()
		const nowOff = await redactTextOrThrow(fx.email)
		expect(nowOff).toBe(fx.email)

		writeSettings({ entities: { PHONE_NUMBER: "on" } })
		// No resetRedactorEngine: the config signature change must rebuild.
		const result = await redactTextOrThrow(`Call ${fx.phone}; mail ${fx.email}`)
		expect(result).toContain("[REDACTED-PHONE_NUMBER]")
		expect(result).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result).not.toContain(fx.email)
	})

	it("the org-managed policy applies per key above local settings", async () => {
		writeSettings({ entities: { EMAIL_ADDRESS: "off" } })
		await setOrgPolicyForTests({
			redaction: {
				categories: { network: "KIMCHI_REDACTION_STATE_OFF" },
				entities: { EMAIL_ADDRESS: "KIMCHI_REDACTION_STATE_ON" },
			},
		})
		resetRedactorEngine()
		// Managed entity state wins over the local OFF; managed category
		// fills the IP key the local file never set.
		const result = await redactTextOrThrow(`mail ${fx.email} bind ${fx.ipAddress}`)
		expect(result).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(result).toContain(fx.ipAddress)
	})

	it("a local entity toggle can name a managed custom entity", async () => {
		writeSettings({ entities: { ACME_EMPLOYEE_ID: "off" } })
		await setOrgPolicyForTests({
			redaction: {
				customEntities: [{ name: "ACME_EMPLOYEE_ID", category: "identity_documents", pattern: "E\\d{6}" }],
			},
		})
		resetRedactorEngine()
		const input = "assigned to E123456"
		// Local OFF governs the org-defined entity; no parse throw, no redaction.
		expect(await redactTextOrThrow(input)).toBe(input)
	})

	it("an unrecognized managed entry drops with a log instead of breaking the pipeline", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		await setOrgPolicyForTests({
			redaction: { categories: { future_category: "KIMCHI_REDACTION_STATE_OFF" } },
		})
		resetRedactorEngine()
		const result = await redactTextOrThrow(`mail ${fx.email}`)
		expect(result).toContain("[REDACTED-EMAIL_ADDRESS]")
		expect(errSpy.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/dropped/)
		errSpy.mockRestore()
	})
})
