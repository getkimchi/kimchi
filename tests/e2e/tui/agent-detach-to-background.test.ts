/**
 * E2E for Ctrl+B detach-to-background.
 *
 * response[0]: orchestrator calls Agent (foreground, no run_in_background)
 * response[1]: inner agent's slow stream (time to press Ctrl+B before it finishes)
 * response[2]: orchestrator follow-up (consumed if it continues its turn)
 *
 * Widget tags are the assertion target — the tool result is collapsed
 * behind "N lines returned" and not reliably visible.
 */

import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function foregroundAgentCall(id: string, description: string, prompt: string) {
	return {
		id,
		function: {
			name: "Agent",
			arguments: JSON.stringify({ prompt, description, subagent_type: "General-Purpose" }),
		},
	}
}

// Slow enough that the test has ample time to press Ctrl+B before the
// inner agent finishes. 4 chunks × 2.5s = 10s window — generous even on
// a slow CI runner where startup + tool-call processing eats 2–3s.
const SLOW_STREAM = { stream: ["chunk ", "one ", "chunk ", "two"], textDelayMs: 2_500 }

test("Ctrl+B detaches a running foreground agent to background", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-detach-ctrl-b",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				// response[0]: orchestrator calls Agent (foreground, no run_in_background)
				{ toolCalls: [foregroundAgentCall("call_agent_detach_1", "detach me", "Reply with: finished")] },
				// response[1]: inner agent's slow stream — press Ctrl+B before it finishes
				SLOW_STREAM,
				// response[2]: orchestrator follow-up after the detached tool result returns.
				// The detach path returns a textResult, so control goes back to the
				// orchestrator which consumes this response. If a flaky model reply
				// doesn't acknowledge, PROMPT_READY still appears because the tool
				// result itself unblocks the editor — but the test asserts [background]
				// which only shows if the detach path ran correctly.
				{ stream: ["acknowledged"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("please spawn a slow agent")
			await waitForText(terminal, "ctrl+shift+b to run in background", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("foreground agent running")

			terminal.keyPress("b", { ctrl: true, shift: true })
			await waitForText(terminal, "[background]", { timeoutMs: 5_000 })
			await waitForText(terminal, PROMPT_READY, { timeoutMs: 5_000 })

			const view = viewText(terminal)
			expect(view).toContain("[background]")
			expect(view).not.toContain("ctrl+shift+b to run in background")
			trace.step("detached: [background] tag shown, hint gone, editor returned")
		},
	)
})

test("Ctrl+B with no foreground agent is a no-op", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-detach-no-op",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [{ stream: ["simple ", "reply"] }],
		},
		async (_fixture, trace) => {
			terminal.submit("just say hi")
			await waitForText(terminal, "simple reply", { timeoutMs: STREAM_TIMEOUT_MS })

			terminal.keyPress("b", { ctrl: true, shift: true })
			// Wait long enough for any erroneous detach output to render on a slow
			// CI runner. 800ms covers the 200ms nudge delay + render latency.
			await new Promise((resolve) => setTimeout(resolve, 800))

			const view = viewText(terminal)
			expect(view).not.toContain("sent to background")
			expect(view).not.toContain("[background]")
			trace.step("no detach text leaked")
		},
	)
})

test("completion notification fires after detached agent finishes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-detach-completion-notification",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{ toolCalls: [foregroundAgentCall("call_agent_completion_1", "long task", "Reply with: task done")] },
				// 3s per chunk × 2 chunks = 6s window. Startup + tool-call processing
				// consumes ~2s, leaving ~4s to press Ctrl+B — comfortable on CI.
				{ stream: ["task ", "done"], textDelayMs: 3_000 },
				{ stream: ["delegated"] },
				{ stream: ["got the result"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("spawn a long task")
			await waitForText(terminal, "ctrl+shift+b to run in background", { timeoutMs: STREAM_TIMEOUT_MS })

			terminal.keyPress("b", { ctrl: true, shift: true })
			await waitForText(terminal, "[background]", { timeoutMs: 5_000 })
			trace.step("detached to background")

			await waitForText(terminal, /long task[^\n]*completed/, { timeoutMs: 15_000 })
			trace.step("completion notification shown")
		},
	)
})
