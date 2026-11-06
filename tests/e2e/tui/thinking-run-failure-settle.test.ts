import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Bug repro: a run that dies mid-thinking without a final `updateContent`
 * leaves the message's live preview pulsing "Thinking ·" forever — it looks
 * like the turn is still running. On a provider stream cut mid-reasoning,
 * the run fails and the failure message renders below, but the orphaned
 * preview is never replaced by the settled collapsed label.
 *
 * Desired behavior (asserted): after the failure surfaces and the editor is
 * ready again, the thinking block has settled to the collapsed "Thinking..."
 * label and no pulsing live header remains.
 *
 * `test.fail` => expected fail (CI green) while the bug stands; when fixed it
 * passes unexpectedly and tui-test flags it — the signal to drop `.fail`.
 */

const REASONING_MODEL: FakeModel[] = [
	{
		slug: "cut-model",
		displayName: "Fake Cut",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

// Every attempt (the harness retries transient stream errors) is cut after
// the 2nd reasoning delta, so no retry can complete the run with a normal
// response and mask the failure.
const CUT_AFTER_TWO_THINKING_CHUNKS = Array.from({ length: 5 }, () => ({
	thinking: ["E2E-CUT-MARKER one ", "E2E-CUT-MARKER two ", "E2E-CUT-MARKER three"],
	closeSocketAfterChunks: 2,
}))

test.fail("thinking preview settles after a run dies mid-thinking", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-run-failure-settle",
			models: REASONING_MODEL,
			extraArgs: ["--model", "cut-model"],
			responses: CUT_AFTER_TWO_THINKING_CHUNKS,
		},
		async (_fixture, trace) => {
			terminal.submit("think about it")
			trace.step("submitted prompt")

			// The live preview header appears once reasoning starts.
			await waitForText(terminal, "Thinking", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("thinking preview visible")

			// The provider cut the socket mid-thinking; the run must fail and
			// return the editor to ready — the user sees the turn is over.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("run failed, editor ready again")

			// Give the failure-triggered repaints a moment, then the orphaned
			// message must show the settled collapsed label, not the pulse.
			await new Promise((resolve) => setTimeout(resolve, 1_500))
			const text = fullText(terminal)

			expect(text).toContain("Thinking...")
			expect(text).not.toMatch(/Thinking [·•]/)
		},
	)
})
