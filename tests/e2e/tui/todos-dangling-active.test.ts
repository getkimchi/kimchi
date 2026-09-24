import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Bug repro (session 01a0cd6c / Discord "borked todos" screenshot): the model
// marks 2 of 3 todos completed, delivers its final summary, and nothing nudges
// it to close the remaining active todo — the pinned overlay strands "1 active"
// forever after the session's final turn. test.fail => expected fail (CI
// green); when the turn-end closure steer (Approach B) lands, the unexpected
// pass is the signal to remove `test.fail` and keep this as the regression
// test. The two reserved trailing responses are consumed by the steer's
// follow-up model call.
test.fail("terminal turn strands a dangling active todo with no closure nudge", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todos-dangling-active",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				{
					stream: ["Planning the work."],
					toolCalls: [
						{
							id: "call_create_todos",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "read inputs", status: "pending" },
										{ content: "run the analysis", status: "pending" },
										{ content: "write the summary", status: "pending" },
									],
								}),
							},
						},
					],
				},
				{
					toolCalls: [
						{
							id: "call_work",
							function: { name: "bash", arguments: JSON.stringify({ command: "sleep 0.2" }) },
						},
					],
				},
				{
					toolCalls: [
						{
							id: "call_mark_1",
							function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
						},
						{
							id: "call_mark_2",
							function: { name: "mark_todo", arguments: JSON.stringify({ id: 2, status: "completed" }) },
						},
					],
				},
				{ stream: ["Work complete."] },
				// Reserved for the turn-end closure steer's follow-up model call.
				{
					toolCalls: [
						{
							id: "call_mark_3",
							function: { name: "mark_todo", arguments: JSON.stringify({ id: 3, status: "completed" }) },
						},
					],
				},
				{ stream: ["All todos closed."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("run the task")
			await waitForText(terminal, "Work complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("final summary delivered")

			// Give any turn-end closure nudge room to fire (currently none exists —
			// the bug), then reopen the list without further user-model interaction.
			await new Promise((resolve) => setTimeout(resolve, 1500))
			terminal.write("/todos")
			await waitForText(terminal, "/todos", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /todos")
			terminal.submit("")

			// Baseline (bug): the reopened list still shows "2/3 done · 1 active".
			// Desired end state once the closure steer exists: all items closed.
			await waitForText(terminal, "3/3 done · 0 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("all todos closed after terminal turn")
		},
	)
})
