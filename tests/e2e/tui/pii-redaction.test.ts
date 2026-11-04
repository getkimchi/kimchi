import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * The PII redaction extension (src/extensions/pii-redaction/) hooks
 * `before_provider_request` and scrubs PII/secrets from outgoing messages
 * before they reach the LLM provider. It is gated by the
 * `extensions.pii-redaction` resource (enabled here transitively via
 * KIMCHI_ENABLE_RESOURCES). These TUI E2E tests verify the full
 * pipeline end-to-end: a user types PII into the TUI, the prompt is
 * transformed through the extension, and the fake OpenAI server records
 * the redacted request body.
 *
 * Each test inspects `fixture.fake.requests` — the recorded HTTP request
 * bodies — to assert that PII patterns are absent and redaction markers
 * are present in the `messages` array the provider actually received.
 */

/** Extract the last user message text from a recorded chat-completions request body. */
function lastUserMessage(request: { body: unknown }): string {
	const body = request.body as Record<string, unknown> | null
	if (!body || typeof body !== "object") return ""
	const messages = body.messages
	if (!Array.isArray(messages)) return ""
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown> | null
		if (msg?.role !== "user") continue
		const content = msg.content
		if (typeof content === "string") return content
		if (Array.isArray(content)) {
			return content
				.map((part) => {
					if (typeof part === "string") return part
					const record = part as Record<string, unknown> | null
					return record && typeof record.text === "string" ? record.text : ""
				})
				.join("")
		}
	}
	return ""
}

/** Find the first chat-completions request recorded by the fake server. */
function firstChatRequest(fixture: { fake: { requests: Array<{ url: string; body: unknown }> } }): {
	url: string
	body: unknown
} {
	const chatRequests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
	expect(chatRequests.length).toBeGreaterThan(0)
	return chatRequests[0]
}

function withRedactionEnabled<T extends { env?: Record<string, string> }>(
	options: T,
): T & { env: Record<string, string> } {
	return { ...options, env: { ...options.env, KIMCHI_ENABLE_RESOURCES: "extensions.pii-redaction" } }
}

type RecordedChatRequest = { url: string; body: unknown }

function findToolContextRequest(
	fixture: { fake: { requests: RecordedChatRequest[] } },
	toolCallId: string,
): RecordedChatRequest | undefined {
	const chatRequests = fixture.fake.requests.filter((r) => r.url.includes("/chat/completions"))
	return chatRequests.find((r) => {
		const body = r.body as Record<string, unknown> | null
		const messages = body?.messages
		return Array.isArray(messages) && JSON.stringify(messages).includes(toolCallId)
	})
}

async function waitForToolContextRequest(
	fixture: { fake: { requests: RecordedChatRequest[] } },
	toolCallId: string,
	timeoutMs = 15_000,
): Promise<RecordedChatRequest> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const request = findToolContextRequest(fixture, toolCallId)
		if (request) return request
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(
		`Timed out waiting for chat request containing ${toolCallId}. Recorded URLs: ${JSON.stringify(
			fixture.fake.requests.map((r) => r.url),
		)}`,
	)
}

test("redacts email from user prompt; bare-shape phone passes through by default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-email-phone",
			responses: [{ stream: ["OK"] }],
		}),
		async (fixture) => {
			terminal.submit("Contact me at alice@example.com or call 555-867-5309")

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			// Email is checksum-validated — redacted regardless of context.
			expect(userText).not.toContain("alice@example.com")
			// Phone is a bare-shape detector: off by default under the tier
			// policy (digit runs collide with order numbers and account IDs).
			// The email's marker must still appear.
			expect(userText).toContain("555-867-5309")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("redacts Bearer tokens and AWS access keys from user prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-secrets",
			responses: [{ stream: ["Done"] }],
		}),
		async (fixture) => {
			terminal.submit("Use Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 and AWS key AKIAIOSFODNN7EXAMPLE")

			await expect(terminal.getByText("Done", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			expect(userText).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
			expect(userText).not.toContain("AKIAIOSFODNN7EXAMPLE")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("redacts credit card and IBAN from user prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-financial",
			responses: [{ stream: ["Noted"] }],
		}),
		async (fixture) => {
			terminal.submit("Pay with card 4111111111111111 or IBAN GB29NWBK60161331926819")

			await expect(terminal.getByText("Noted", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			expect(userText).not.toContain("4111111111111111")
			expect(userText).not.toContain("GB29NWBK60161331926819")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("preserves surrounding text when redacting PII", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-preservation",
			responses: [{ stream: ["OK"] }],
		}),
		async (fixture) => {
			terminal.submit("Please review the file at /home/user/project and email bob@corp.org")

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			expect(userText).toContain("/home/user/project")
			expect(userText).toContain("Please review")
			expect(userText).not.toContain("bob@corp.org")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("redacts kimchi API key from Bearer authorization header in prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-api-key",
			responses: [{ stream: ["OK"] }],
		}),
		async (fixture) => {
			terminal.submit("Debug this: Authorization: Bearer abc123def456ghi789jkl012mno345pqr678stu901")

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			// The full Bearer token (the API key) must be redacted — the key
			// value must never reach the provider.
			expect(userText).not.toContain("abc123def456ghi789jkl012mno345pqr678stu901")
			expect(userText).not.toContain("Bearer abc123")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("leaves PII untouched when the redaction resource is off (the default)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pii-redaction-disabled",
			responses: [{ stream: ["OK"] }],
		},
		async (fixture) => {
			terminal.submit("Reach me at alice@example.com or 555-867-5309")

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			expect(userText).toContain("alice@example.com")
			expect(userText).toContain("555-867-5309")
			expect(userText).not.toContain("[REDACTED")
		},
	)
})

test("redacts PII in tool-call arguments before LLM sees them in context", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-tool-call-args",
			responses: [
				// First response: fake model calls bash with a command containing PII
				{
					stream: ["Running check..."],
					toolCalls: [
						{
							id: "call_bash_1",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "echo Authorization: Bearer abc123def456ghi789jkl012mno345pqr678stu901",
								}),
							},
						},
					],
				},
				// Second response: final text after tool result
				{ stream: ["Done"] },
			],
		}),
		async (fixture) => {
			terminal.submit("Check the auth token")

			await expect(terminal.getByText("Running check...", { full: true })).toBeVisible()

			// The second request contains the tool-call and tool-result in context.
			// The tool-call arguments (which contain the Bearer token) must be redacted.
			// Session-name title generation requests also hit /chat/completions, so
			// wait for the continuation request that includes the tool-call id.
			const toolRequest = await waitForToolContextRequest(fixture, "call_bash_1")

			const requestBody = toolRequest.body as Record<string, unknown> | null
			const messages = requestBody?.messages
			expect(Array.isArray(messages)).toBe(true)

			// Serialize non-system messages — system messages are skipped by
			// redaction (they contain structural identifiers like ferment IDs).
			const nonSystemMessages = (messages as Array<Record<string, unknown>>).filter((m) => m.role !== "system")
			const serialized = JSON.stringify(nonSystemMessages)
			expect(serialized).not.toContain("abc123def456ghi789jkl012mno345pqr678stu901")
			expect(serialized).toContain("[REDACTED")
		},
	)
})

test("redacts PII in tool results before LLM sees them in context", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-tool-result",
			responses: [
				// First response: fake model calls bash, which will echo PII
				{
					stream: ["Checking config..."],
					toolCalls: [
						{
							id: "call_bash_2",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "echo john.doe@example.com AKIAIOSFODNN7EXAMPLE",
								}),
							},
						},
					],
				},
				// Second response: final text after tool result
				{ stream: ["Reviewed."] },
			],
		}),
		async (fixture) => {
			terminal.submit("Check what's in the config")

			await expect(terminal.getByText("Checking config...", { full: true })).toBeVisible()

			// The second request contains the tool result in context.
			// The tool result text (bash output with email + AWS key) must be redacted.
			const toolRequest = await waitForToolContextRequest(fixture, "call_bash_2")

			const requestBody = toolRequest.body as Record<string, unknown> | null
			const messages = requestBody?.messages
			expect(Array.isArray(messages)).toBe(true)

			// Serialize non-system messages — system messages are skipped by redaction.
			const nonSystemMessages = (messages as Array<Record<string, unknown>>).filter((m) => m.role !== "system")
			const serialized = JSON.stringify(nonSystemMessages)
			expect(serialized).not.toContain("john.doe@example.com")
			expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE")
			expect(serialized).toContain("[REDACTED")

			const rawEmail = "john.doe@example.com"
			const sessionsRoot = join(fixture.agentDir, "sessions")
			const listSessionFiles = (root: string): string[] => {
				if (!existsSync(root)) return []
				const out: string[] = []
				for (const entry of readdirSync(root)) {
					const entryPath = join(root, entry)
					if (entry.endsWith(".jsonl")) {
						out.push(entryPath)
					} else {
						try {
							out.push(...listSessionFiles(entryPath))
						} catch {
							// a non-directory entry — nothing to descend into
						}
					}
				}
				return out
			}
			const findToolResultRecord = (): string | undefined => {
				for (const sessionFile of listSessionFiles(sessionsRoot)) {
					for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
						if (!line.includes("call_bash_2") || !line.includes("toolResult")) continue
						try {
							JSON.parse(line)
							return line
						} catch {
							// partially written line — keep polling
						}
					}
				}
				return undefined
			}
			const deadline = Date.now() + 10_000
			let toolResultLine: string | undefined
			do {
				toolResultLine = findToolResultRecord()
				if (toolResultLine === undefined) {
					await new Promise((resolve) => setTimeout(resolve, 250))
				}
			} while (toolResultLine === undefined && Date.now() < deadline)
			expect(toolResultLine).toBeDefined()
			const stored = JSON.parse(toolResultLine ?? "") as { message?: { details?: unknown } }
			const detailsJson = JSON.stringify(stored.message?.details ?? null)
			expect(detailsJson).not.toContain(rawEmail)
			expect(detailsJson).toContain("[REDACTED")
		},
	)
})

// ---------------------------------------------------------------------------
// OTLP telemetry — the pii_redaction.* records the console consumes
// ---------------------------------------------------------------------------

interface OtlpLogRecord {
	eventName?: string
	attributes?: Array<{ key: string; value?: { stringValue?: string } }>
}

/** Flatten every log record POSTed to the fake /logs endpoint into {eventName, attrs}. */
function collectRecords(fixture: { fake: { requests: Array<{ url: string; body: unknown }> } }): Array<{
	eventName: string
	attrs: Record<string, string>
}> {
	const out: Array<{ eventName: string; attrs: Record<string, string> }> = []
	for (const request of fixture.fake.requests.filter((r) => r.url.startsWith("/logs"))) {
		const body = request.body as {
			resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: OtlpLogRecord[] }> }>
		} | null
		for (const rl of body?.resourceLogs ?? []) {
			for (const sl of rl.scopeLogs ?? []) {
				for (const record of sl.logRecords ?? []) {
					const attrs: Record<string, string> = {}
					for (const attr of record.attributes ?? []) attrs[attr.key] = attr.value?.stringValue ?? ""
					out.push({ eventName: record.eventName ?? "", attrs })
				}
			}
		}
	}
	return out
}

test("emits per-entity pii_redaction.redacted + session_affected OTLP records when redaction fires", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		withRedactionEnabled({
			artifactName: "pii-redaction-events-telemetry",
			responses: [{ stream: ["OK"] }],
			seedHome(home, _cwd, fakeBaseUrl) {
				const configPath = join(home, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
				config.telemetry = {
					enabled: true,
					endpoint: `${fakeBaseUrl}/logs`,
					metricsEndpoint: `${fakeBaseUrl}/metrics`,
				}
				writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`)
			},
		}),
		async (fixture) => {
			// Fixture value assembled at runtime: a literal card number here would
			// itself be redacted to a marker on disk by any agent pipeline that
			// edits this file (CREDIT_CARD is Luhn-validated, always on).
			const card = ["4532", "0151", "1283", "0366"].join("")
			terminal.submit(`Contact me at alice@example.com or pay with CC: ${card}`)

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			// Telemetry flushes in 5s batches — poll until both record kinds land.
			const deadline = Date.now() + 20_000
			let records: ReturnType<typeof collectRecords> = []
			while (Date.now() < deadline) {
				records = collectRecords(fixture)
				const names = records.map((r) => r.eventName)
				if (names.includes("pii_redaction.redacted") && names.includes("pii_redaction.session_affected")) break
				await new Promise((resolve) => setTimeout(resolve, 250))
			}

			// Exactly one session_affected latch record.
			const sessionAffected = records.filter((r) => r.eventName === "pii_redaction.session_affected")
			if (sessionAffected.length !== 1) {
				throw new Error(
					`expected 1 session_affected record, got ${sessionAffected.length}. Event names seen: ${JSON.stringify(
						records.map((r) => r.eventName),
					)}. Requests logged: ${fixture.fake.requests.length}`,
				)
			}

			// One record per redacted entity type on the user_input surface.
			const redacted = records.filter((r) => r.eventName === "pii_redaction.redacted")
			expect(redacted.map((r) => r.attrs.entity_type).sort()).toEqual(["CREDIT_CARD", "EMAIL_ADDRESS"])
			for (const record of redacted) {
				expect(record.attrs.surface).toBe("user_input")
				expect(record.attrs.count).toBe("1")
			}

			// Privacy: neither the raw PII values nor the surrounding scan
			// context ever reach the OTLP endpoint.
			for (const request of fixture.fake.requests.filter((r) => r.url.startsWith("/logs"))) {
				const serialized = JSON.stringify(request.body)
				expect(serialized).not.toContain("alice@example.com")
				expect(serialized).not.toContain(card)
				expect(serialized).not.toContain("Contact me at")
			}
		},
	)
})

test("emits no pii_redaction OTLP records when the resource is off", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pii-redaction-events-disabled",
			responses: [{ stream: ["OK"] }],
			seedHome(home, _cwd, fakeBaseUrl) {
				const configPath = join(home, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
				config.telemetry = {
					enabled: true,
					endpoint: `${fakeBaseUrl}/logs`,
					metricsEndpoint: `${fakeBaseUrl}/metrics`,
				}
				writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`)
			},
		},
		async (fixture) => {
			terminal.submit("Contact alice@example.com")
			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			// Give one flush window a chance; then assert absence.
			await new Promise((resolve) => setTimeout(resolve, 6_000))
			expect(collectRecords(fixture).map((r) => r.eventName)).not.toContain("pii_redaction.redacted")
			expect(collectRecords(fixture).map((r) => r.eventName)).not.toContain("pii_redaction.session_affected")
		},
	)
})
