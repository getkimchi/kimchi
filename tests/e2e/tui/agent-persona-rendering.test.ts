import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("Agent renders its persona without a transient bare header", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-persona-rendering",
			responses: [
				{
					rawDeltas: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_agent_persona",
										type: "function",
										function: {
											name: "Agent",
											arguments: '{"prompt":"Inspect the renderer","description":"inspect renderer"',
										},
									},
								],
							},
						},
						{ delta: { content: "Selecting the persona." } },
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										function: { arguments: ',"subagent_type":"Explore"}' },
									},
								],
							},
							delayMs: 1_500,
						},
					],
					finishReason: "tool_calls",
				},
				{ stream: ["Renderer inspection complete."] },
				{ stream: ["Delegation complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Ask Explore to inspect the renderer")

			await waitForText(terminal, "Selecting the persona.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).not.toMatch(/^\s*▸ Agent(?:\s{2}|$)/m)
			trace.step("partial Agent call did not render a bare header")

			await waitForText(terminal, "▸ Explore  inspect renderer", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("completed Agent call rendered the Explore persona")

			await waitForText(terminal, "Delegation complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("orchestrator completed after the Explore agent")
		},
	)
})
