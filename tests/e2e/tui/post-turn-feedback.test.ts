import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("User rates a response and the reason is recorded in the transcript", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "post-turn-feedback",
			// The prompt summary (which carries the rating invitation) is
			// suppressed when a turn reports no token usage, so the fake
			// response must report some.
			responses: [{ stream: ["Here is the answer."], usage: { prompt_tokens: 120, completion_tokens: 30 } }],
		},
		async (_fixture, trace) => {
			terminal.submit("Explain the build step")

			await waitForText(terminal, "Here is the answer.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("assistant turn completed")

			// The rating invitation appears under the prompt summary once the
			// agent has settled.
			await waitForText(terminal, "Rate response:", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("rating invitation shown after the turn")

			// Ctrl+1 rates the response as Good and opens the reason dialog.
			// Sent as a Kitty CSI-u sequence: Ctrl+<digit> has no legacy control
			// byte, so this is the only encoding that reaches the shortcut.
			terminal.write("\x1b[49;5u")
			await waitForText(terminal, "Rate response", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Your rating: Good", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("reason dialog opened with the chosen sentiment")

			// Pick the first predefined reason and submit.
			terminal.write("1")
			terminal.write("\r")

			await waitForText(terminal, "Thanks, feedback received!", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Reason: Solved my task", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("feedback summary rendered in the transcript")

			// The summary is a custom entry, so the dialog chrome is gone.
			expect(fullText(terminal)).not.toContain("[Enter] Submit")
		},
	)
})
