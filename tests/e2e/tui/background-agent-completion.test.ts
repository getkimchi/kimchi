/**
 * TUI e2e test: background agent completion UX.
 *
 * Verifies the user-visible completion flow for background agents:
 * 1. A background agent produces result text visible in the terminal
 * 2. No phantom error or stale "still running" state after completion
 * 3. The prompt becomes ready again after the agent finishes
 *
 * The WS disconnect → reconnecting → recovery state machine is fully
 * unit-tested in remote-agent-runner.test.ts (35 tests covering reattach,
 * finish-while-away, unreachable, abort, no-delete-on-error, steer,
 * onReconnecting callback, and single-completion-invocation across all
 * recovery paths). TUI e2e tests spawn the real kimchi binary and cannot
 * mock internal modules (WorkerClient/AcpSessionClient) to simulate WS
 * disconnects at the transport layer — and remote: true requires real
 * cloud credentials (listWorkspaces fails with the fake API key). So this
 * test focuses on the end-to-end completion UX that the TUI renders for
 * background agents.
 */

import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("background agent produces result text without errors", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "background-agent-completion",
			responses: [
				{
					toolCalls: [
						{
							id: "call_remote_1",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Fix the bug in auth.ts",
									description: "remote fix",
									subagent_type: "General-Purpose",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["The", " bug", " is", " fixed", " by", " adding", " a", " null", " check."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("run a background agent to fix the bug")

			await waitForText(terminal, "remote fix", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("agent spawned")

			const view = viewText(terminal)
			expect(view).toContain("remote fix")

			await waitForText(terminal, "null check", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("agent result visible")

			const finalView = viewText(terminal)
			expect(finalView).not.toContain("result unknown")
		},
	)
})

test("background agent completion shows prompt ready without stale state", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "remote-run-completion",
			responses: [
				{
					toolCalls: [
						{
							id: "call_remote_2",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Add a test file",
									description: "add test",
									subagent_type: "General-Purpose",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["Created", " test", " file", " successfully."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("spawn a background agent to add a test")

			await waitForText(terminal, "add test", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("agent spawned")

			await waitForText(terminal, "successfully", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("completion text visible")

			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })

			const view = viewText(terminal)
			expect(view).not.toContain("result unknown")
		},
	)
})
