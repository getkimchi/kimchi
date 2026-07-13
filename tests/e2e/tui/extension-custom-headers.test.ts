import { expect, test } from "@microsoft/tui-test"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Kimchi telemetry uses PI's upstream `before_provider_headers` hook to attach
 * session context to every LLM call. This verifies the production extension's
 * headers reach the HTTP request recorded by the fake OpenAI server.
 *
 * Node's HTTP server lower-cases incoming header names.
 */
test("telemetry injects session context headers into LLM requests", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "telemetry-provider-headers",
			responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
		},
		async (fixture, trace) => {
			terminal.submit("Say hello")
			trace.step("submitted prompt")

			await expect(terminal.getByText("Hello from fake Kimchi.", { full: true })).toBeVisible()
			trace.step("response rendered")

			const chatRequests = fixture.fake.requests.filter((request) =>
				request.url.startsWith("/openai/v1/chat/completions"),
			)
			expect(chatRequests.length).toBeGreaterThan(0)

			const headers = chatRequests[0].headers
			expect(headers["x-session-id"]).toMatch(/^[0-9a-f-]{36}$/)
			expect(headers["x-turn-index"]).toMatch(/^\d+$/)
			trace.step("telemetry session headers reached the provider request")
		},
	)
})
