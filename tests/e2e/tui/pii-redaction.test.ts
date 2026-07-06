import { expect, test } from "@microsoft/tui-test"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * The PII redaction extension (src/extensions/pii-redaction/) hooks
 * `before_provider_request` and scrubs PII/secrets from outgoing messages
 * before they reach the LLM provider. These TUI E2E tests verify the full
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
		if (!msg || msg.role !== "user") continue
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

test("redacts email and phone from user prompt before LLM receives it", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pii-redaction-email-phone",
			responses: [{ stream: ["OK"] }],
		},
		async (fixture) => {
			terminal.submit("Contact me at alice@example.com or call 555-867-5309")

			await expect(terminal.getByText("OK", { full: true })).toBeVisible()

			const request = firstChatRequest(fixture)
			const userText = lastUserMessage(request as { body: unknown })

			expect(userText).not.toContain("alice@example.com")
			expect(userText).not.toContain("555-867-5309")
			expect(userText).toContain("[REDACTED")
		},
	)
})

test("redacts Bearer tokens and AWS access keys from user prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pii-redaction-secrets",
			responses: [{ stream: ["Done"] }],
		},
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
		{
			artifactName: "pii-redaction-financial",
			responses: [{ stream: ["Noted"] }],
		},
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
		{
			artifactName: "pii-redaction-preservation",
			responses: [{ stream: ["OK"] }],
		},
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
		{
			artifactName: "pii-redaction-api-key",
			responses: [{ stream: ["OK"] }],
		},
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

test("disables redaction when KIMCHI_REDACTION_ENABLED=0", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pii-redaction-disabled",
			responses: [{ stream: ["OK"] }],
			env: { KIMCHI_REDACTION_ENABLED: "0" },
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
