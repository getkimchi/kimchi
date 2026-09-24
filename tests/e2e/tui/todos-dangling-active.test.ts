import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const scenario of ["completed", "deferred", "superseded"]) {
	const deferred = scenario === "deferred"
	const cancelled = scenario === "superseded"
	test(
		deferred
			? "settled reconciliation preserves deferred work"
			: cancelled
				? "settled reconciliation retains superseded work as cancelled"
				: "settled reconciliation closes a forgotten todo without another main-agent turn",
		async ({ terminal }) => {
			const reconciliation: FakeResponseScript = {
				match(request) {
					const body = request.body as { messages?: { role: string; content: string }[] }
					if (
						!body.messages?.some(
							(message) => message.role === "system" && message.content.startsWith("Reconcile todo bookkeeping"),
						)
					)
						return false
					const user = body.messages.find((message) => message.role === "user")
					if (!user) throw new Error("Reconciliation request omitted transcript")
					const input = JSON.parse(user.content)
					const proof = input.transcript.find((entry: { role: string }) => entry.role === "toolResult:bash")
					reconciliation.stream = [
						JSON.stringify({
							updates: [
								{
									id: 1,
									status: cancelled ? "cancelled" : "completed",
									reason: cancelled ? "Replacement completed" : "Input verified",
									evidence: [proof.entryId],
								},
							],
						}),
					]
					return true
				},
				stream: [],
			}
			await runKimchiSession(
				terminal,
				{
					artifactName: deferred ? "todos-preserve-deferred" : "todos-dangling-active",
					models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
					responses: [
						reconciliation,
						{
							toolCalls: [
								{
									id: "create",
									function: {
										name: "create_todos",
										arguments: JSON.stringify({
											todos: [
												{ content: cancelled ? "Old approach" : "Verify input", status: "in_progress" },
												{ content: "Collect results", status: "pending" },
												{ content: deferred ? "Publish after approval" : "Compare results", status: "pending" },
											],
										}),
									},
								},
							],
						},
						{
							toolCalls: [
								{
									id: "work",
									function: { name: "bash", arguments: JSON.stringify({ command: "printf 'input verified\\n'" }) },
								},
							],
						},
						{
							toolCalls: [
								{
									id: "mark2",
									function: { name: "mark_todo", arguments: JSON.stringify({ id: 2, status: "completed" }) },
								},
							],
						},
						...(deferred
							? []
							: [
									{
										toolCalls: [
											{
												id: "mark3",
												function: { name: "mark_todo", arguments: JSON.stringify({ id: 3, status: "completed" }) },
											},
										],
									},
								]),
						{ stream: [deferred ? "Analysis complete. Publishing awaits approval." : "Comparison complete."] },
					],
				},
				async (fixture, trace) => {
					terminal.submit(
						deferred
							? "Analyze the input; defer publishing until I approve."
							: "Verify the input and compare the results.",
					)
					await waitForText(terminal, deferred ? "Analysis complete." : "Comparison complete.", {
						timeoutMs: STREAM_TIMEOUT_MS,
					})
					trace.step("main answer delivered with first todo still active")
					if (deferred) {
						await waitForText(terminal, "2/3 done · 1 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
						await waitForText(terminal, "Publish after approval", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
					} else {
						const deadline = Date.now() + STREAM_TIMEOUT_MS
						while (/\d+\/\d+ done/.test(viewText(terminal)) && Date.now() < deadline)
							await new Promise((resolve) => setTimeout(resolve, 100))
						expect(viewText(terminal)).not.toMatch(/\d+\/\d+ done/)
					}
					trace.step("reconciled widget reflects completed and deferred work")
					terminal.write("/todos")
					await waitForText(terminal, "/todos", { timeoutMs: STREAM_TIMEOUT_MS })
					terminal.submit("")
					// Deferred lists were already expanded, so /todos collapses them. Completed lists reopen.
					if (!deferred)
						await waitForText(terminal, cancelled ? "2/3 done · 0 active · 1 cancelled" : "3/3 done · 0 active", {
							timeoutMs: STREAM_TIMEOUT_MS,
							full: false,
						})
					const chat = fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
					expect(chat).toHaveLength(deferred ? 5 : 6)
					expect(JSON.stringify(chat)).not.toContain("terminal-turn-closure")
					trace.step("one tool-free reconciliation request and no main-agent continuation")
				},
			)
		},
	)
}
