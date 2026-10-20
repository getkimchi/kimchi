import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function requestContainsToolResult(body: unknown, toolCallId: string): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return false
	return messages.some(
		(message) =>
			Boolean(message && typeof message === "object") &&
			(message as Record<string, unknown>).role === "tool" &&
			(message as Record<string, unknown>).tool_call_id === toolCallId,
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
							id: "call_redirect",
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

			const continuation = fixture.fake.requests.find((request) =>
				requestContainsToolResult(request.body, "call_redirect"),
			)
			expect(continuation).toBeDefined()
			expect(JSON.stringify(continuation?.body)).not.toContain("Bash-tool guard")
			trace.step("stderr redirect completed without a guard steer")
		},
	)
})

test("file reads via bash produce no guard steer", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-tool-guard-file-read-no-steer",
			responses: [
				{
					stream: ["Checking the OS."],
					toolCalls: [
						{
							id: "call_read",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "cat /etc/os-release" }),
							},
						},
					],
				},
				{ stream: ["Read checks complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Check the OS release file")
			await waitForText(terminal, "Read checks complete.", { timeoutMs: STREAM_TIMEOUT_MS })

			const continuation = fixture.fake.requests.find((request) => requestContainsToolResult(request.body, "call_read"))
			expect(continuation).toBeDefined()
			expect(JSON.stringify(continuation?.body)).not.toContain("Bash-tool guard")
			trace.step("file read via bash completed without a guard steer")
		},
	)
})

test("backgrounding produces the background guard steer", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-tool-guard-background-steer",
			responses: [
				{
					stream: ["Starting the workload."],
					toolCalls: [
						{
							id: "call_bg",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 60 &" }),
							},
						},
					],
				},
				{ stream: ["Backgrounding handled."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Kick off the long-running workload")
			// The visible completion proves the session continued past the
			// steer (the steer itself is display:false and never renders).
			await waitForText(terminal, "Backgrounding handled.", { timeoutMs: STREAM_TIMEOUT_MS })

			const continuation = fixture.fake.requests.find((request) => requestContainsToolResult(request.body, "call_bg"))
			expect(continuation).toBeDefined()
			const body = JSON.stringify(continuation?.body)
			expect(body).toContain("detaches the process from the bash tool's lifecycle")
			expect(body).toContain("bash_control stop_handles")
			trace.step("backgrounding steer reached the model with the rewritten text")
		},
	)
})
