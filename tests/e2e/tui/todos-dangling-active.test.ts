import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Bug repro + regression test (session 01a0cd6c / Discord "borked todos" screenshot): the model
// marks 2 of 3 todos completed, delivers its final summary, and the turn-end
// closure steer must nudge it to close the remaining active todo. Baseline
// (no steer): the pinned overlay stranded "2/3 done · 1 active" forever —
// verified failing before the closure steer landed. The two reserved trailing
// responses are consumed by the steer's follow-up model call.
test("terminal turn strands a dangling active todo with no closure nudge", async ({ terminal }) => {
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
				// Two sequential turns, one mark each: mark_todo registers with
				// executionMode "parallel", so two mark calls in ONE response race
				// their read-modify-write and one write is lost (observed while
				// debugging the closure steer — separate harness finding).
				{
					toolCalls: [
						{
							id: "call_mark_1",
							function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
						},
					],
				},
				{
					toolCalls: [
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

			// The closure steer fires at the terminal turn's end and its
			// continuation closes the dangling todo — waiting for the reserved
			// scripted response proves the steer reached the model. (Never type
			// input to verify the list: a still-streaming continuation queues it
			// as a prompt instead of running the /todos command.)
			await waitForText(terminal, "All todos closed.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("closure steer continuation closed the dangling todo")

			// Final state: the pinned overlay only stays up while active todos
			// exist, so once the continuation marks the last item completed the
			// overlay disappears from the viewable buffer. Two consecutive clean
			// checks guard against transient renders mid-update.
			const deadline = Date.now() + STREAM_TIMEOUT_MS
			let cleanChecks = 0
			while (cleanChecks < 2 && Date.now() < deadline) {
				cleanChecks = /\d+\/\d+ done/.test(viewText(terminal)) ? 0 : cleanChecks + 1
				if (cleanChecks < 2) await new Promise((resolve) => setTimeout(resolve, 250))
			}
			if (cleanChecks < 2) {
				throw new Error("Timed out waiting for the pinned todo overlay to hide (active todos remain).")
			}
			trace.step("todo overlay unpinned after the last item closed")
		},
	)
})
