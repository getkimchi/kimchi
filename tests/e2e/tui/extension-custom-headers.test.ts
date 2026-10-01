import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Pi's public `before_provider_headers` hook carries Kimchi telemetry headers to the provider. */
test("telemetry injects session and turn headers into LLM requests", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "extension-custom-headers",
			responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
		},
		async (fixture, trace) => {
			terminal.submit("Say hello")
			trace.step("submitted prompt")

			await expect(terminal.getByText("Hello from fake Kimchi.", { full: true })).toBeVisible()
			trace.step("response rendered")

			const request = fixture.fake.requests.find((item) => item.url.startsWith("/openai/v1/chat/completions"))
			expect(request).toBeDefined()
			expect(request?.headers["x-session-id"]).toBeTruthy()
			expect(request?.headers["x-conversation-id"]).toBeTruthy()
			expect(request?.headers["x-turn-index"]).toMatch(/^\d+$/)
		},
	)
})
