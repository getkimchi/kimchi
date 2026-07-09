/**
 * E2E regression test for duplicate Agent header rendering.
 *
 * Before the fix, the generic OpenAI-style tool renderer and the agent-specific
 * renderer both emitted an "Agent <description>" header, producing duplicate
 * header lines in the chat output. This test verifies the header appears
 * exactly once when a foreground agent is running.
 */

import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

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

const SLOW_STREAM = { stream: ["working", " working", " working", " working"], textDelayMs: 5_000 }

test("foreground Agent tool call header is not duplicated", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-dup-header",
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{ toolCalls: [foregroundAgentCall("call_agent_dup_hdr_1", "dup check", "Reply with: finished")] },
				SLOW_STREAM,
				{ stream: ["acknowledged"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("spawn a slow agent")
			await waitForText(terminal, "ctrl+b to run in background", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("foreground agent running")

			const view = viewText(terminal)
			// The call header line "▸ General Purpose  dup check" must appear exactly once.
			// Before the fix, it appeared twice (once from generic renderer, once from agent renderer).
			const headerOccurrences = (view.match(/General Purpose.*dup check/g) || []).length
			expect(headerOccurrences).toBe(1)

			// The agent-specific spinner hint must appear at most once.
			const hintOccurrences = (view.match(/ctrl\+b to run in background/g) || []).length
			expect(hintOccurrences).toBeLessThanOrEqual(1)

			trace.step("agent header is not duplicated")
		},
	)
})
