import { expect, test } from "@microsoft/tui-test"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("basic session lifecycle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "basic-session-lifecycle",
			responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
		},
		async (fixture) => {
			terminal.submit("Say hello")

			await expect(terminal.getByText("Hello from fake Kimchi.", { full: true })).toBeVisible()
			expect(fixture.fake.requests.some((request) => request.url.startsWith("/openai/v1/chat/completions"))).toBe(true)
		},
	)
})
