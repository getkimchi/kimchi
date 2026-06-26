import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
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

test("todo widget shows rolling markers around active work", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-rolling-window",
			responses: [
				{
					stream: ["Rolled", " todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: Array.from({ length: 19 }, (_, index) => ({
										content: `task ${index + 1}`,
										status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
									})),
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Create rolling todos")

			await waitForText(terminal, "9/19 done · 10 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 7 completed", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "  8.  ✓ task 8", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "  9.  ✓ task 9", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 10.  ▶ task 10", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 14.  ○ task 14", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 5 more", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("rolling active window visible")

			const text = viewText(terminal)
			expect(text).not.toContain("  1.  ✓ task 1")
			expect(text).not.toContain(" 19.  ○ task 19")
		},
	)
})

test("todo widget anchors completed overflow at the end", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-completed-end",
			responses: [
				{
					stream: ["All", " completed."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: Array.from({ length: 19 }, (_, index) => ({
										content: `task ${index + 1}`,
										status: "completed",
									})),
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Create completed todos")
			await waitForText(terminal, "All completed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })

			terminal.write("/todos")
			await waitForText(terminal, "/todos", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")

			await waitForText(terminal, "19/19 done · 0 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 10 completed", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 11.  ✓ task 11", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 19.  ✓ task 19", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("completed end window visible")

			const text = viewText(terminal)
			expect(text).not.toContain("  1.  ✓ task 1")
			expect(text).not.toContain("… 9 more")
		},
	)
})
