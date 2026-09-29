import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const scenario of ["completed", "deferred", "ignored"]) {
	test(`one cleanup reminder handles ${scenario} work without looping`, async ({ terminal }) => {
		const tool = (name: string, args: Record<string, unknown>): FakeResponseScript => ({
			toolCalls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
		})
		const deferred = scenario === "deferred"
		await runKimchiSession(
			terminal,
			{
				artifactName: `todo-cleanup-${scenario}`,
				models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
				responses: [
					tool("create_todos", {
						todos: [
							{
								content: deferred ? "Publish after approval" : "Verify input",
								status: deferred ? "pending" : "in_progress",
							},
							{ content: "Collect results", status: "pending" },
							{ content: "Compare results", status: "pending" },
						],
					}),
					tool("bash", { command: "printf 'input verified\\n'" }),
					tool("mark_todo", { id: 2, status: "completed" }),
					tool("mark_todo", { id: 3, status: "completed" }),
					{ stream: ["Comparison complete."] },
					...(scenario === "ignored"
						? []
						: [
								tool(
									"mark_todo",
									deferred
										? { id: 1, status: "pending", note: "Deferred until explicit approval" }
										: { id: 1, status: "completed" },
								),
							]),
					{ stream: ["Cleanup check finished."] },
				],
			},
			async (fixture, trace) => {
				terminal.submit(
					deferred
						? "Compare the input; publishing is deferred until approval."
						: "Verify the input and compare results.",
				)
				await waitForText(terminal, "Cleanup check finished.", { timeoutMs: STREAM_TIMEOUT_MS })
				if (scenario === "completed") {
					const deadline = Date.now() + STREAM_TIMEOUT_MS
					while (/\d+\/\d+ done/.test(viewText(terminal)) && Date.now() < deadline)
						await new Promise((resolve) => setTimeout(resolve, 100))
					expect(viewText(terminal)).not.toMatch(/\d+\/\d+ done/)
					terminal.submit("/todos")
					await waitForText(terminal, "3/3 done · 0 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
				} else {
					await waitForText(terminal, "2/3 done · 1 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					if (deferred) expect(viewText(terminal)).toContain("Publish after approval")
				}
				const chat = fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
				expect(chat).toHaveLength(scenario === "ignored" ? 6 : 7)
				const body = chat[5].body as { messages: { role: string; content: unknown }[] }
				expect(JSON.stringify(body.messages)).toContain("The turn ended with unfinished todos")
				expect(JSON.stringify(body.messages)).toContain("Preserve deferred")
				trace.step("one reminder, existing todo tools, no extra evaluator or repeated cleanup")
			},
		)
	})
}
