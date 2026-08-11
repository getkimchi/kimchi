import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { type KimchiFixture, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Extract the todo state injection from a recorded chat completion request.
 * The state is injected transiently at the tail of the message context via
 * the `context` event (converted to a user-role message before reaching the
 * provider), NOT in the system prompt — the system prompt stays stable so
 * provider-side prompt caching is never disturbed. Returns the message
 * content containing the todo state block, or undefined if none found.
 */
function getMessageWithTodos(fixture: KimchiFixture): string | undefined {
	const chatRequests = fixture.fake.requests.filter((req) => req.url.includes("/chat/completions"))
	for (let i = chatRequests.length - 1; i >= 0; i--) {
		const body = chatRequests[i].body as
			| { messages?: Array<{ role: string; content: Array<{ type: string; text: string }> }> }
			| undefined
		const messages = body?.messages
		if (!Array.isArray(messages)) continue
		for (const msg of messages) {
			if (!Array.isArray(msg.content)) continue
			for (const block of msg.content) {
				if (block.type === "text" && block.text.includes("## Current Todos")) {
					return block.text
				}
			}
		}
	}
	return undefined
}

/**
 * The model must see its own todo state on every LLM call in TUI mode.
 * After the model writes todos via update_todos, the ## Current Todos block
 * is injected at the tail of the message context for subsequent requests.
 *
 * The injection happens via the `context` event (fires per LLM call) rather
 * than the system prompt — so state is fresh on every turn, appears even
 * mid-run without a new user prompt, and never mutates the cached prompt
 * prefix.
 */
test("model sees ## Current Todos injected in context after writing todos (TUI mode)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-prompt-injection",
			responses: [
				// Turn 1 of prompt 1: model writes global-scope todos
				{
					stream: ["I'll track my work."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "write the code", status: "in_progress" },
										{ content: "run tests", status: "pending" },
									],
								}),
							},
						},
					],
				},
				// Turn 2 of prompt 1: model stops — force end of first agent run
				{ stream: [] },
				// Prompt 2 response: model reads its own state from the system prompt
				{ stream: ["I can see my todos in the system prompt."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("ready prompt visible")

			terminal.submit("Create a todo list")
			trace.step("submitted prompt")

			// Wait for the todo widget to appear (proves the store has the todos)
			await waitForText(terminal, "Todos · Global", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "write the code", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "run tests", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("todo widget appeared with items")

			// Submit a second user input — the context handler injects the
			// populated todo state at the tail of the next request.
			terminal.submit("Continue working")
			trace.step("submitted second prompt")

			// Wait for the response to the second user input specifically
			await waitForText(terminal, "I can see my todos", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("second prompt response rendered")

			// A message in the request should contain the injected todo block
			const todoMessage = getMessageWithTodos(fixture)
			expect(todoMessage).toBeDefined()
			if (!todoMessage) throw new Error("expected a request message containing injected todos")
			expect(todoMessage).toContain("## Current Todos")
			expect(todoMessage).toContain("write the code")
			expect(todoMessage).toContain("run tests")
			trace.step("## Current Todos block verified in model context")
		},
	)
})

/**
 * The TUI widget should show all non-empty scopes together — not just one
 * resolved scope. When multiple scopes have todos, all should be visible
 * in one view: step sub-tasks and global todos.
 *
 * Uses ferment-step scope (model-writable) rather than ferment phase scope
 * (bridge-managed, read-only to tools).
 */
test("widget shows multiple scopes together", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-multi-scope",
			responses: [
				// Turn 1: model writes global todos
				{
					stream: ["Adding global todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "global task A", status: "in_progress" },
										{ content: "global task B", status: "pending" },
									],
								}),
							},
						},
					],
				},
				// Turn 2: model writes scoped todos with explicit step scope
				{
					stream: ["Adding scoped todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
									todos: [
										{ content: "Write code", status: "completed" },
										{ content: "Run tests", status: "pending" },
									],
								}),
							},
						},
					],
				},
				{ stream: ["Done."] },
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("ready prompt visible")

			terminal.submit("Add todos")
			trace.step("submitted prompt")

			// Wait for global todos to appear
			await waitForText(terminal, "Todos · Global", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "global task A", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("global scope visible")

			terminal.submit("Add more todos")
			trace.step("submitted second prompt")

			// Wait for the step scope to also appear
			await waitForText(terminal, "Todos · Step", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Write code", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Run tests", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("step scope visible")

			// Both scopes should be visible simultaneously in the terminal
			const text = viewText(terminal)
			expect(text).toContain("Todos · Global")
			expect(text).toContain("Todos · Step")
			expect(text).toContain("global task A")
			expect(text).toContain("global task B")
			expect(text).toContain("Write code")
			expect(text).toContain("Run tests")
			trace.step("multi-scope widget verified: all scopes visible together")
		},
	)
})

// Status bar multi-scope test removed — the widget multi-scope test above
// already verifies that all scopes render together in the terminal view.
