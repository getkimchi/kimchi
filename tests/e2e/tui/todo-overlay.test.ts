import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("todo overlay hides completed lists", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-overlay-completed-hidden",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				{
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
			],
		},
		async (_fixture, trace) => {
			terminal.submit("create todos")
			await waitForText(terminal, "Todo plan created.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Todos · Global", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "0/2 done · 2 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("active todos overlay visible")

			terminal.submit("/todos done 1")
			await waitForText(terminal, "Updated todo 1.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "Todos · Global", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "1/2 done · 1 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("partially completed overlay remains visible")

			terminal.submit("/todos done 2")
			await waitForText(terminal, "Updated todo 2.", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForViewToExclude(terminal, "Todos · Global")
			await waitForViewToExclude(terminal, "2/2 done · 0 active")
			trace.step("completed-only overlay hidden")

			terminal.submit("/todos")
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

			await waitForViewToExclude(terminal, "Todos · Global")
			await waitForViewToExclude(terminal, "2/3 done · 1 active")
			trace.step("reconciliation follow-up cleared overlay")
		},
	)
})

async function waitForViewToExclude(terminal: Terminal, text: string): Promise<void> {
	const startedAt = Date.now()
	let view = viewText(terminal)
	while (Date.now() - startedAt < INPUT_TIMEOUT_MS) {
		if (!view.includes(text)) return
		await new Promise((resolve) => setTimeout(resolve, 100))
		view = viewText(terminal)
	}
	throw new Error(`Timed out waiting for ${JSON.stringify(text)} to leave the terminal view.\n\nTerminal:\n${view}`)
}
