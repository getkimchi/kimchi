/**
 * TUI e2e test: background subagents survive /branch.
 *
 * The agents extension treats `session_shutdown {reason:"fork"}` as a
 * continuation, not a termination: running local agents are handed off to the
 * branched session (subagent-handoff.ts) instead of being aborted. This test
 * drives the full user-visible flow:
 *
 * 1. A background Explore agent spawns and starts a slow response.
 * 2. /branch replaces the session while the agent is mid-run.
 * 3. The branch notice confirms the agent was handed over, and the widget row
 *    keeps rendering in the branched session.
 * 4. The agent's completion notification — with its result preview — arrives
 *    in the branched session, proving the hand-off delivered the result that
 *    master silently discarded.
 *
 * The subagent's scripted response streams with per-chunk delays so it is
 * still running when the branch happens, then completes on its own.
 */

import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("background agents keep running across /branch and complete in the branch", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "branch-subagents-survive",
			responses: [
				{
					toolCalls: [
						{
							id: "call_agent_branch_survive",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Inspect the project layout",
									description: "inspect layout",
									subagent_type: "Explore",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["Delegated.", " The agent runs in the background."] },
				// The subagent's own request: slow chunks keep it mid-run while
				// the branch replaces the session, then it completes on its own.
				{
					forSubagent: true,
					stream: ["Layout", " inspection", " complete", " —", " done", " thoroughly."],
					delayMs: 1000,
				},
				// The completion notification triggers a turn in the branched session.
				{ stream: ["Noted", " the", " result."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("ask Explore to inspect the layout in the background")

			await waitForText(terminal, "inspect layout", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("background agent spawned and visible")
			await waitForText(terminal, "Delegated.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("main turn finished while the agent keeps running")

			terminal.submit("/branch repro")
			await waitForText(terminal, "[kimchi-session-branch]", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("branch box rendered")

			// The branch notice ("Branch created — N background agent(s) still running")
			// is a transient toast — its text is pinned by the branch-command unit
			// tests; the e2e asserts the durable surface instead.

			// The adopted agent's widget row keeps rendering in the branched session.
			await waitForText(terminal, "Explore", { timeoutMs: STARTUP_TIMEOUT_MS })
			const branchedView = viewText(terminal)
			expect(branchedView).toContain("inspect layout")

			// The completion notification — result preview included — must land
			// in the branched session. On master this notification was silently
			// dropped with the aborted agent.
			await waitForText(terminal, "Layout inspection complete", { timeoutMs: 30_000 })
			trace.step("agent completed in the branched session with its result delivered")
			await waitForText(terminal, "Noted the result.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })

			const finalView = viewText(terminal)
			expect(finalView).not.toContain("result unknown")
		},
	)
})
