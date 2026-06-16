import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("ctrl-c aborts a streaming response", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "interrupt-handling",
			responses: [
				{
					stream: ["first chunk ", "second chunk ", "third chunk "],
					delayMs: 500,
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Stream slowly")
			trace.step("submitted streaming prompt")
			await waitForText(terminal, "first chunk", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first stream chunk visible before ctrl-c")
			terminal.keyCtrlC()
			trace.step("sent ctrl-c during streaming response")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("ready prompt visible after stream interrupt")

			const chatRequest = fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequest).toBeDefined()
		},
	)
})
