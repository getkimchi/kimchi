import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("completed todos stop pinning the overlay", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-overlay-completed-hide",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				{
					// Emit orientation text first; the first-turn-orientation guard
					// blocks tool calls on the first turn without prior text_delta.
					stream: ["Setting up todos."],
					toolCalls: [
						{
							id: "call_create_todos",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "sticky panel", status: "pending" },
										{ content: "follow-up prompt", status: "pending" },
									],
								}),
							},
						},
					],
				},
				{ stream: ["Todo plan created."] },
				{ stream: ["fake response"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("create todos")
			await waitForText(terminal, "Todo plan created.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Todos · Global", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "0/2 done · 2 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("active todos overlay visible")

			// Write + submit separately — one-shot `terminal.submit("/todos done 1\r")`
			// races the TUI's autocomplete accept path on rapid slash commands and
			// can swallow the Enter key, dropping the command. Same workaround as
			// the theme-selector tests.
			terminal.write("/todos done 1")
			await waitForText(terminal, "/todos done 1", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /todos done 1")
			terminal.submit("")
			await waitForText(terminal, "Updated todo 1.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Todos · Global", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "1/2 done · 1 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("partially completed overlay remains visible")

			terminal.write("/todos done 2")
			await waitForText(terminal, "/todos done 2", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /todos done 2")
			terminal.submit("")
			// Wait for the stable overlay-state outcome first (overlay disappears
			// because there are no active todos). The "Updated todo N."
			// notification is transient — it can render for only one frame
			// before the widget re-renders, so checking it via the viewable
			// buffer is racy. The notification is preserved in the full
			// buffer; we assert it there after the stable state has settled.
			await waitForWidgetToHide(terminal)
			await waitForText(terminal, "Updated todo 2.", { timeoutMs: INPUT_TIMEOUT_MS, full: true })
			trace.step("completed-only overlay hidden")

			terminal.submit("continue after completed todos")
			await waitForText(terminal, "fake response", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForWidgetToHide(terminal)
			trace.step("follow-up prompt did not reopen completed-only overlay")

			terminal.write("/todos")
			await waitForText(terminal, "/todos", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /todos")
			terminal.submit("")
			await waitForText(terminal, "Todos · Global", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "2/2 done · 0 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("completed overlay manually reopened")
		},
	)
})

test("todo overlay reconciles stale active todos after non-todo work", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-overlay-reconciliation",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				{
					// Emit orientation text first; the first-turn-orientation guard
					// blocks tool calls on the first turn without prior text_delta.
					stream: ["Reconciling the todo list."],
					toolCalls: [
						{
							id: "call_leave_active_todo",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "create branch", status: "completed" },
										{ content: "edit workflow", status: "completed" },
										{ content: "commit and push", status: "in_progress" },
									],
								}),
							},
						},
					],
				},
				{
					toolCalls: [
						{
							id: "call_non_todo_work",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 0.2" }),
							},
						},
					],
				},
				{ stream: ["Work finished."] },
				{
					toolCalls: [
						{
							id: "call_clear_reconciled_todos",
							function: { name: "clear_todos", arguments: JSON.stringify({}) },
						},
					],
				},
				{ stream: [] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("leave an active todo")

			await waitForText(terminal, "2/3 done · 1 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("active todo overlay visible")

			await waitForWidgetToHide(terminal)
			trace.step("reconciliation follow-up cleared overlay")
		},
	)
})

/**
 * Wait for the todo widget to leave the terminal view. The widget is hidden
 * when there are no active todos, so this is the stable signal that the
 * most recent `/todos` command has been processed. Prefer over polling the
 * transient "Updated todo N." notification, which can be skipped entirely
 * if the widget re-render coincides with the slash-command handler's
 * notification render.
 */
async function waitForWidgetToHide(terminal: Terminal): Promise<void> {
	const startedAt = Date.now()
	let view = viewText(terminal)
	while (Date.now() - startedAt < INPUT_TIMEOUT_MS) {
		if (!view.includes("Todos · Global") && !view.includes("done · 0 active")) return
		await new Promise((resolve) => setTimeout(resolve, 100))
		view = viewText(terminal)
	}
	throw new Error(`Timed out waiting for todo widget to hide.\n\nTerminal:\n${view}`)
}
