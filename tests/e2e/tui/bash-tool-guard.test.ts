import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const TOOL_CALL_ID = "call_redirect"

function requestContainsToolResult(body: unknown): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return false
	return messages.some(
		(message) =>
			Boolean(message && typeof message === "object") &&
			(message as Record<string, unknown>).role === "tool" &&
			(message as Record<string, unknown>).tool_call_id === TOOL_CALL_ID,
	)
}

test("stderr redirects do not queue bash guard turns", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-tool-guard-stderr-redirects",
			responses: [
				{
					stream: ["Checking commands."],
					toolCalls: [
						{
							id: TOOL_CALL_ID,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo redirect 2>&1" }),
							},
						},
					],
				},
				{ stream: ["Redirect checks complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run the redirect checks")
			await waitForText(terminal, "Redirect checks complete.", { timeoutMs: STREAM_TIMEOUT_MS })

			const continuation = fixture.fake.requests.find((request) => requestContainsToolResult(request.body))
			expect(continuation).toBeDefined()
			expect(JSON.stringify(continuation?.body)).not.toContain("Bash-tool guard")
			trace.step("stderr redirect completed without a guard steer")
		},
	)
})
