import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * E2E coverage for the cooking animation's behavior across an assistant
 * turn:
 *
 *  - The spinner must remain visible during the reasoning phase.
 *  - The "(thinking…)" suffix must be rendered while reasoning deltas arrive.
 *  - When text content starts streaming, the spinner must switch off so the
 *    status bar doesn't show a stale cooking message while the response
 *    renders in the chat area.
 *
 * The fake OpenAI server's `thinking` field emits `delta.reasoning_content`
 * chunks (consumed by pi-ai's openai-completions provider and mapped to
 * `thinking_start` / `thinking_delta` / `thinking_end` events) BEFORE the
 * visible `stream` text. Per-chunk delays ensure the reasoning window is
 * long enough for the TUI to render the spinner.
 */
test("cooking animation stays visible during reasoning and clears when text starts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "indicator-thinking",
			// Opt into a reasoning-capable fake model so the test exercises the
			// actual reasoning code path (rather than relying on the fake server
			// emitting reasoning_content chunks that the upstream provider
			// would, on a non-reasoning model, be free to ignore).
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					// 5 reasoning chunks spaced 250ms apart → ~1s of visible thinking.
					// The first reasoning_content delta triggers `thinking_start`, which
					// in turn re-arms the spinner with the "(thinking…)" suffix.
					thinking: ["Let me ", "think ", "about ", "this ", "carefully."],
					thinkingDelayMs: 250,
					// Then the visible response. The `text_start` event triggered by the
					// first content chunk kills the spinner.
					stream: ["The ", "answer ", "is ", "4."],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("What is 2+2?")
			trace.step("submitted prompt")

			// The spinner message (a cooking frame + the "(thinking…)" suffix) must
			// appear after the first reasoning chunk arrives.
			await waitForText(terminal, "(thinking…)", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("spinner shows (thinking…) suffix during reasoning")

			// The response text appears once the content chunks stream in.
			await waitForText(terminal, "The answer is 4.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response text rendered")

			// After text starts, the spinner suffix must be gone — `text_start`
			// killed it via stopIndicator, and `message_end` is a defensive cleanup.
			// Allow a brief render tick before asserting.
			await new Promise((resolve) => setTimeout(resolve, 300))
			const view = viewText(terminal)
			expect(view).not.toContain("(thinking…)")
			expect(view).not.toContain("(thought for")
			// The response itself is still there.
			expect(view).toContain("The answer is 4.")
			trace.step("spinner suffix is gone after text begins streaming")
		},
	)
})

/**
 * Covers the pre-first-reasoning-delta gap: between `turn_start` (which
 * starts the spinner) and the first `message_update` (which arrives only
 * after the LLM stream produces its first content/reasoning delta). If
 * the model's reasoning-setup time exceeds a few hundred milliseconds —
 * common for Sonnet/Opus high thinking, GPT-5 reasoning effort, Kimi K2.5
 * thinking — the spinner must stay visible during that gap so the user
 * isn't staring at a blank TUI.
 */
test("cooking animation is visible during the gap between message_start and the first reasoning delta", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "indicator-thinking-gap",
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					// Long delay before the first thinking chunk to widen the
					// pre-thinking gap (this is what the test is verifying), then
					// several spaced thinking chunks so the animator's setInterval
					// has time to tick and render the (thinking…) suffix before
					// text arrives.
					thinking: ["Hmm", " let me", " think", " about", " this."],
					thinkingDelayMs: 800,
					stream: ["Done."],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Slow thinking model")
			trace.step("submitted prompt")

			// A cooking-frame message ("Stirring", "Chopping", etc.) must be in the
			// viewport during the pre-thinking gap. The exact frame is
			// non-deterministic — the spinner cycles every 6s — so match any of
			// the first few frames.
			await waitForText(terminal, /(Stirring|Marinating|Chopping)/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking frame visible during pre-thinking gap")

			// Then the (thinking…) suffix must appear once the first reasoning
			// chunk arrives.
			await waitForText(terminal, "(thinking…)", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("(thinking…) suffix appears once reasoning begins")

			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response rendered")
		},
	)
})

/**
 * Defensive coverage: pure-text turn (no reasoning) must NOT show the
 * "(thinking…)" suffix. The cooking animation should be active during the
 * pre-text gap, but the suffix only renders when thinkingStatus is set.
 */
test("cooking animation shows no (thinking…) suffix for plain-text responses", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "indicator-thinking-no-suffix",
			responses: [{ stream: ["Just plain ", "text."], textDelayMs: 100 }],
		},
		async (_fixture, trace) => {
			terminal.submit("Reply without thinking")
			trace.step("submitted prompt")

			await waitForText(terminal, "Just plain text.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response rendered")

			// Give the spinner a chance to render — it should have run during the
			// message_start → text_start gap (no thinking occurred), so the suffix
			// must be absent.
			await new Promise((resolve) => setTimeout(resolve, 200))
			const full = fullText(terminal)
			expect(full).not.toContain("(thinking…)")
			expect(full).not.toContain("(thought for")
			trace.step("no (thinking…) suffix for plain-text responses")
		},
	)
})
