/**
 * TUI e2e test: a subagent's outgoing request carries its FINAL system
 * prompt — the one resolved after the session is bound, listing the active
 * tools the child can actually call (single-load contract from the
 * subagent-double-extension-load investigation).
 *
 * agent-runner used to reload the child loader a second time after binding
 * to re-evaluate the system prompt; that reload constructed a duplicate
 * extension set behind the live one. The live-prompt loader adapter made the
 * second reload unnecessary, so this test pins the user-visible behavior the
 * refactor must preserve: the model serving the child sees the resolved
 * tool list, and the delegation completes normally.
 */

import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("subagent request advertises its resolved active tool list", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-final-prompt",
			responses: [
				{
					toolCalls: [
						{
							id: "call_agent_final_prompt",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Inspect the project layout",
									description: "inspect layout",
									subagent_type: "Explore",
								}),
							},
						},
					],
				},
				// Routed to the subagent's own request (detected via the
				// parent-session header / inherited-prompt marker).
				{ stream: ["Layout inspection complete."], forSubagent: true },
				{ stream: ["Delegation complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Ask Explore to inspect the layout")

			await waitForText(terminal, "▸ Explore  inspect layout", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("Agent call rendered the Explore persona")
			await waitForText(terminal, "Delegation complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("orchestrator completed after the Explore agent")

			// The subagent's own request: its system prompt is the FINAL
			// prompt built after binding — the active-tool list section with
			// the tools the child can actually call, plus the persona block.
			const subagentRequests = fixture.fake.requests.filter((request) => {
				if (!request.url.endsWith("/chat/completions")) return false
				const messages = (request.body as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages
				if (!Array.isArray(messages)) return false
				return messages.some(
					(m) => m.role === "system" && JSON.stringify(m.content).includes("inherited_system_prompt"),
				)
			})
			expect(subagentRequests.length).toBe(1)

			const first = subagentRequests[0]
			const messages = (first?.body as { messages?: Array<{ role: string; content: unknown }> })?.messages
			const system = messages?.find((m) => m.role === "system")
			const systemText = system && typeof system.content === "string" ? system.content : JSON.stringify(system?.content)
			expect(systemText).toContain("## Available Tools")
			expect(systemText).toContain("- read")
			expect(systemText).toContain("- grep")
			trace.step("subagent system prompt carries the resolved tool list")
		},
	)
})
