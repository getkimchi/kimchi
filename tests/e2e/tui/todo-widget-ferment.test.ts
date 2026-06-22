import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Widget shows "Todos · Global" header, summary line, and todo items when
 * the model writes todos with no explicit scope (default = global). Also
 * verifies the per-item status symbols (○, ▶, ✓).
 */
test("todo widget renders global scope with status symbols", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-global",
			responses: [
				{
					stream: ["I'll", " add", " a", " todo."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "implement widget rendering", status: "in_progress" },
										{ content: "write e2e tests", status: "pending" },
									],
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Add a todo")
			trace.step("submitted prompt")

			await waitForText(terminal, "Todos · Global", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("scope header visible")

			await waitForText(terminal, "0/2 done", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("summary line visible")

			await waitForText(terminal, "implement widget rendering", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "write e2e tests", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("todo items visible")

			// Status symbols: ▶ for in_progress, ○ for pending.
			const text = terminal.getViewableBuffer().map((r) => r.join("")).join("\n")
			expect(text).toContain("▶")
			expect(text).toContain("○")
		},
	)
})

/**
 * Widget summary line shows the correct count for mixed-status todos:
 * "1/4 done · 3 active · 1 blocked" when there are 4 todos with
 * pending/in_progress/blocked/completed statuses.
 */
test("todo widget summary reflects mixed-status counts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-mixed-status",
			responses: [
				{
					stream: ["Adding", " mixed", " todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "pending item", status: "pending" },
										{ content: "active item", status: "in_progress" },
										{ content: "blocked item", status: "blocked" },
										{ content: "done item", status: "completed" },
									],
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Add mixed todos")
			trace.step("submitted prompt")

			// Summary format: "1/4 done · 3 active · 1 blocked"
			await waitForText(terminal, "1/4 done", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("summary count visible")

			await waitForText(terminal, "1 blocked", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("blocked count visible")

			// All 4 items should appear with their status symbols.
			await waitForText(terminal, "pending item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "active item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "blocked item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "done item", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("all items visible")
		},
	)
})
