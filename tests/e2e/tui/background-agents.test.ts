/**
 * E2E for Ctrl+B detach-to-background and Ctrl+X kill.
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

function backgroundAgentCall(id: string, description: string, prompt: string) {
	return {
		id,
		function: {
			name: "Agent",
			arguments: JSON.stringify({ prompt, description, subagent_type: "General-Purpose", run_in_background: true }),
		},
	}
}

const SLOW_STREAM = { stream: ["working", " working", " working", " working"], textDelayMs: 5_000 }

test("Ctrl+B detaches a running foreground agent to background", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-detach-ctrl-b",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{ toolCalls: [foregroundAgentCall("call_agent_detach_1", "detach me", "Reply with: finished")] },
				SLOW_STREAM,
				{ stream: ["acknowledged"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("please spawn a slow agent")
			await waitForText(terminal, "ctrl+b to run in background", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("foreground agent running")

			terminal.keyPress("b", { ctrl: true })
			await waitForText(terminal, "[background]", { timeoutMs: 5_000 })
			await waitForText(terminal, PROMPT_READY, { timeoutMs: 5_000 })

			const view = viewText(terminal)
			expect(view).toContain("[background]")
			expect(view).not.toContain("ctrl+b to run in background")
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

			terminal.keyPress("b", { ctrl: true })
			await new Promise((resolve) => setTimeout(resolve, 400))

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
				{ stream: ["task ", "done"], textDelayMs: 1_200 },
				{ stream: ["delegated"] },
				{ stream: ["got the result"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("spawn a long task")
			await waitForText(terminal, "ctrl+b to run in background", { timeoutMs: STREAM_TIMEOUT_MS })

			terminal.keyPress("b", { ctrl: true })
			await waitForText(terminal, "[background]", { timeoutMs: 5_000 })
			trace.step("detached to background")

			await waitForText(terminal, /long task[^\n]*completed/, { timeoutMs: 15_000 })
			trace.step("completion notification shown")
		},
	)
})

test("Ctrl+X kills background agents one by one", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-kill-ctrl-x-two",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				// Orchestrator turn 1: spawn first bg
				{ toolCalls: [backgroundAgentCall("call_kill_1", "first bg", "Reply with: working")] },
				// Inner agent "first bg" — slow stream so it's still running when we kill
				SLOW_STREAM,
				// Orchestrator turn 2: spawn second bg
				{ toolCalls: [backgroundAgentCall("call_kill_2", "second bg", "Reply with: working")] },
				// Inner agent "second bg" — slow stream
				SLOW_STREAM,
				// Orchestrator follow-up
				{ stream: ["acknowledged"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("spawn two background agents")
			await waitForText(terminal, "first bg", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "second bg", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("two background agents running")

			// Kill the most recent one (second bg — listAgents sorts by startedAt desc)
			terminal.keyPress("x", { ctrl: true })
			await waitForText(terminal, "Stopped", { timeoutMs: 5_000 })
			trace.step("killed second bg")

			// Wait for the widget to re-render — the kill hint should still be
			// present on the remaining background agent
			await waitForText(terminal, "ctrl+x to kill", { timeoutMs: 5_000 })
			trace.step("kill hint still visible on remaining agent")

			// Kill the remaining one
			terminal.keyPress("x", { ctrl: true })
			await waitForText(terminal, "Stopped", { timeoutMs: 5_000 })
			trace.step("killed first bg")

			// No more background agents — kill hint should be gone
			await new Promise((resolve) => setTimeout(resolve, 500))
			const view = viewText(terminal)
			expect(view).not.toContain("ctrl+x to kill")
			trace.step("no kill hint remaining — all background agents killed")
		},
	)
})
