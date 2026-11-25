/**
 * E2E TUI test: a positional prompt after a boolean flag (`--auto`) must reach
 * the model as the first message. Before the fix, the flag consumed the prompt
 * and the interactive session started empty.
 */

import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROMPT = "Prompt after auto in the TUI."

interface ChatMessage {
	role?: string
	content?: unknown
}

function userText(message: ChatMessage): string {
	if (message.role !== "user") return ""
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")
}

test("a prompt after --auto becomes the first message of an interactive session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "boolean-flag-prompt",
			// The fixture joins extraArgs into one shell command, so quote the prompt.
			extraArgs: ["--auto", `'${PROMPT}'`],
			responses: [{ stream: ["Interactive auto prompt answered.\n"] }],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "Interactive auto prompt answered", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model answer to the initial prompt is visible")

			await waitForText(terminal, PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("user prompt text is visible on the terminal")

			const chatPosts = fixture.fake.requests.filter((r) => r.method === "POST" && r.url.includes("/chat/completions"))
			const sentPrompt = chatPosts.some((r) => {
				const body = r.body as { messages?: ChatMessage[] } | undefined
				return (body?.messages ?? []).some((m) => userText(m).includes(PROMPT))
			})
			expect(sentPrompt).toBe(true)
			trace.step("chat completion request carried the prompt as a user message")
		},
	)
})
