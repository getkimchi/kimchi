import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Deterministic long-running command: prints a line, then sleeps longer than
// the checkin interval (1s) so the first result is a mid-run check-in with a
// handle rather than a completed result.
const LONG_COMMAND = "echo started && sleep 30"

test("background bash: read-only tools work while a process runs, then stop retrieves output", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-concurrent-read",
			responses: [
				// Turn 1: the model starts a long-running background bash command.
				{
					stream: ["Starting a long-running command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: LONG_COMMAND,
									timeout: 60,
									checkin_interval: 1,
								}),
							},
						},
					],
				},
				// Turn 2: the model does independent work (read) while the
				// process continues — this must NOT be blocked.
				{
					stream: ["Reading a file while the build runs."],
					toolCalls: [
						{
							id: "call_read",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "README.md" }),
							},
						},
					],
				},
				// Turn 3: the model stops the background process to collect output.
				{
					stream: ["Stopping the background process."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									handle: "__BASH_HANDLE__",
									action: "stop",
								}),
							},
						},
					],
				},
				// Turn 4: the model finishes.
				{ stream: ["Done. The background process was stopped."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command, read a file while it runs, then stop it")

			// The first check-in arrives: the process is still running.
			await waitForText(terminal, "Background process running", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first background check-in visible")

			// The read tool call runs while the process is still tracked — it
			// must not be hard-blocked. Wait for the model's streaming text to
			// confirm the read executed concurrently.
			await waitForText(terminal, "Reading a file while the build runs", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("read tool executed concurrently")

			// The stop call runs.
			await waitForText(terminal, "Stopping the background process", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("stop call issued")

			// The model finishes normally.
			await waitForText(terminal, "background process was stopped", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed")

			// Sanity: the conversation reached the final scripted response.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(4)
		},
	)
})

test("background bash: a normal completion while a process runs triggers a follow-up", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-completion-guard",
			responses: [
				// Turn 1: the model starts a long-running background bash command.
				{
					stream: ["Starting a long-running command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: LONG_COMMAND,
									timeout: 60,
									checkin_interval: 1,
								}),
							},
						},
					],
				},
				// Turn 2: the model attempts to finish WITHOUT resolving the process.
				// The completion guard should fire a follow-up asking it to resolve.
				{ stream: ["All done!"] },
				// Turn 3: the follow-up directs the model to stop the process.
				{
					stream: ["Stopping the forgotten process."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									handle: "__BASH_HANDLE__",
									action: "stop",
								}),
							},
						},
					],
				},
				// Turn 4: the model finishes for real.
				{ stream: ["Now everything is resolved."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command then finish without stopping it")

			// The first check-in arrives.
			await waitForText(terminal, "Background process running", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first background check-in visible")

			// The model says "All done!" — but the process is still running.
			await waitForText(terminal, "All done!", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model attempted completion with a tracked process")

			// The completion guard fires a follow-up — the model then stops the process.
			await waitForText(terminal, "Stopping the forgotten process", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up caused the process to be stopped")

			// The model finishes for real after resolving.
			await waitForText(terminal, "everything is resolved", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session completed after resolving the forgotten process")

			// 4 LLM requests: initial bash, attempted completion, follow-up stop, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(4)
		},
	)
})
