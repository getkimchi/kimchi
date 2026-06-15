import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("ctrl-c clears draft input and aborts streaming response", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "interrupt-handling.txt",
			responses: [
				{
					stream: ["first chunk ", "second chunk ", "third chunk "],
					delayMs: 500,
				},
			],
		},
		async (fixture) => {
			terminal.write("draft that should clear")
			await waitForText(terminal, "draft that should clear", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.keyCtrlC()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("draft that should clear")

			terminal.submit("Stream slowly")
			await waitForText(terminal, "first chunk", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyCtrlC()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })

			const chatRequest = fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequest).toBeDefined()
		},
	)
})
