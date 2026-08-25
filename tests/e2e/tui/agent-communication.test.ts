import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("communicating child asks through parent, resumes after reply, and shows its final result", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-communication-question-reply-resume",
			seedHome: (_homeDir, workDir) => {
				const agentsDir = join(workDir, ".kimchi", "agents")
				mkdirSync(agentsDir, { recursive: true })
				writeFileSync(
					join(agentsDir, "communicating-child.md"),
					"---\ndescription: communicating child\nprompt_mode: append\nextensions: true\nskills: false\n---\nAsk the user one focused question, then wait for the parent reply.",
					"utf-8",
				)
			},
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{
					toolCalls: [
						{
							id: "call_background_child",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Ask one user question, then stop and await the parent's reply.",
									description: "communicating child",
									subagent_type: "communicating-child",
									communication: "parent",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["background child started"] },
				{
					stream: ["answering the child"],
					textDelayMs: 300,
					toolCalls: [
						{
							id: "call_reply_to_child",
							function: {
								name: "reply_to_agent_message",
								arguments: JSON.stringify({
									message_id: "__MESSAGE_ID__",
									answer: "Use option A.",
									max_turns: 2,
									max_duration: 30,
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					stream: ["child asks: which option should I use?"],
					toolCalls: [
						{
							id: "call_child_question",
							function: {
								name: "send_agent_message",
								arguments: JSON.stringify({
									recipient: { type: "user" },
									payload: {
										kind: "question",
										question: "Which option should I use?",
										impact: "Changes the implementation scope.",
										options: ["A", "B"],
										recommendedDefault: "A",
										canContinue: false,
									},
								}),
							},
						},
					],
				},
				{ forSubagent: true, stream: ["child settled and awaiting the answer"] },
				{ forSubagent: true, stream: ["final report: child received option A"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("start a communicating child")
			await waitForText(terminal, "Which option should I use?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("child question is visible through the parent notification")

			await waitForText(terminal, /requestedAudience=user/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("parent notification carries the user audience")

			await waitForText(terminal, "final report: child received option A", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("bounded continuation returns the child final result")
			expect(viewText(terminal)).toContain("final report: child received option A")
		},
	)
})
