import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function chatRequests(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function systemPromptOf(request: { body: unknown }): string {
	const body = request.body as { messages?: { role: string; content: unknown }[] }
	const system = body.messages?.find((message) => message.role === "system")
	if (typeof system?.content === "string") return system.content
	if (Array.isArray(system?.content)) {
		return system.content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
			.join("\n")
	}
	return ""
}

test("interactive TUI sessions keep Consent, Harness Notes, Documents and the orient ritual", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "system-prompt-interactive-sections",
			responses: [{ stream: ["Acknowledged."] }],
		},
		async (fixture, trace) => {
			terminal.submit("hello")
			await waitForText(terminal, "Acknowledged.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first turn settled")

			const chat = chatRequests(fixture)
			expect(chat.length).toBeGreaterThan(0)
			const prompt = systemPromptOf(chat[0])

			// Interactive (user-loop) sections present.
			expect(prompt).toContain("## Consent & Irreversible Actions")
			expect(prompt).toContain("## Harness Notes and Approval")
			expect(prompt).toContain("## Documents")
			expect(prompt).toContain("orients the user")
			expect(prompt).toContain("## Phase Management")

			// The headless replacement never appears in an interactive session.
			expect(prompt).not.toContain("## Autonomous Session")
		},
	)
})
