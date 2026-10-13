import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Pi's public `before_provider_headers` hook carries Kimchi telemetry headers to the provider. */
test("telemetry injects session and turn headers into LLM requests", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "extension-custom-headers",
			// The continuation nudge fires after a text-only run that used no
			// tools (the second prompt here) and opens an extra LLM round via an
			// injected message; disable it so the round count is exactly the
			// scripted scenario. The background session-naming request targets a
			// different endpoint and never enters the filter below.
			env: { KIMCHI_DISABLE_NUDGE_CONTINUATION: "1" },
			responses: [
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "printf one > one.txt" }),
							},
						},
					],
				},
				{ stream: ["First task done."] },
				{ stream: ["Second task done."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Create one.txt, then summarize.")
			await expect(terminal.getByText("First task done.", { full: true })).toBeVisible()
			trace.step("prompt 1 completed (tool round + text round)")

			terminal.submit("Now reply with a short confirmation.")
			await expect(terminal.getByText("Second task done.", { full: true })).toBeVisible()
			trace.step("prompt 2 completed (one text round)")

			const requests = fixture.fake.requests.filter((item) => item.url.startsWith("/openai/v1/chat/completions"))
			expect(requests.length).toBe(3)
			for (const request of requests) {
				expect(request.headers["x-session-id"]).toBeTruthy()
				expect(request.headers["x-conversation-id"]).toBeTruthy()
			}
			// turn_index is 1-based and strictly increasing across prompts: one
			// value per LLM round-trip, never reset by a new prompt. The old
			// per-prompt-resetting counter would yield ["0", "1", "0"].
			expect(requests.map((request) => request.headers["x-turn-index"])).toEqual(["1", "2", "3"])
		},
	)
})
