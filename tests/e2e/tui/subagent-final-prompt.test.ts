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
import { STREAM_TIMEOUT_MS, waitForRequest, waitForText } from "./support/assertions.js"
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
			// Same detection the fake server uses for its subagent queue: the
			// parent-session header (present when telemetry is enabled) OR the
			// sub-agent prompt marker — CI runs with telemetry off, so the
			// header alone is not reliable there.
			//
			// The Agent tool runs in the background by default, so the
			// orchestrator's follow-up turn ("Delegation complete.") renders
			// while the child is still booting — its request reaches the fake
			// server a beat later. Wait for the evidence instead of asserting
			// against a mid-flight request log (this was the CI flake).
			const isSubagentRequest = (request: (typeof fixture.fake.requests)[number]) => {
				if (!request.url.endsWith("/chat/completions")) return false
				if ((request.headers as Record<string, unknown>)["x-parent-session-id"] !== undefined) return true
				const messages = (request.body as { messages?: Array<{ role: string; content: unknown }> } | null)?.messages
				if (!Array.isArray(messages)) return false
				return messages.some(
					(m) =>
						m.role === "system" &&
						(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes(
							"You are a kimchi coding agent sub-agent.",
						),
				)
			}
			const first = await waitForRequest(
				fixture.fake.requests,
				isSubagentRequest,
				"the subagent's chat/completions request",
			)
			trace.step("subagent request reached the fake server")
			expect(fixture.fake.requests.filter(isSubagentRequest).length).toBe(1)
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
