import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * E2E coverage for the cooking animation's behavior across an assistant
 * turn: it must stay visible during reasoning, render the "(thinking…)"
 * suffix while reasoning deltas arrive, and switch off once visible text
 * starts streaming.
 *
 * The two thinking-capable tests opt into a reasoning-capable fake model
 * (see `models:` below) so the test exercises the actual reasoning code
 * path rather than relying on the fake server emitting reasoning_content
 * chunks that the upstream provider would be free to ignore on a
 * non-reasoning model.
 */
test("cooking animation stays visible during reasoning and clears when text starts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "indicator-thinking",
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					// Spaced reasoning chunks give the animator's setInterval time to
					// tick and render the "(thinking…)" suffix before text arrives.
					thinking: ["Let me ", "think ", "about ", "this ", "carefully."],
					thinkingDelayMs: 250,
					stream: ["The ", "answer ", "is ", "4."],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("What is 2+2?")
			trace.step("submitted prompt")

			await waitForText(terminal, "(thinking…)", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("spinner shows (thinking…) suffix during reasoning")

			await waitForText(terminal, "The answer is 4.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response text rendered")

			// Allow a brief render tick before asserting the suffix cleared.
			await new Promise((resolve) => setTimeout(resolve, 300))
			const view = viewText(terminal)
			expect(view).not.toContain("(thinking…)")
			expect(view).not.toContain("(thought for")
			expect(view).toContain("The answer is 4.")
			trace.step("spinner suffix is gone after text begins streaming")
		},
	)
})

/**
 * Covers the pre-first-reasoning-delta gap. If the model's reasoning-setup
 * time exceeds a few hundred milliseconds, the spinner must stay visible
 * during that gap so the user isn't staring at a blank TUI.
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
					// 800ms delay widens the pre-thinking gap; several thinking chunks
					// give the animator time to tick and render the suffix before text.
					thinking: ["Hmm", " let me", " think", " about", " this."],
					thinkingDelayMs: 800,
					stream: ["Done."],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Slow thinking model")
			trace.step("submitted prompt")

			// Frame is non-deterministic (the spinner cycles every 6s), so match
			// any of the first few cooking frames.
			await waitForText(terminal, /(Stirring|Marinating|Chopping)/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking frame visible during pre-thinking gap")

			await waitForText(terminal, "(thinking…)", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("(thinking…) suffix appears once reasoning begins")

			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response rendered")

			await new Promise((resolve) => setTimeout(resolve, 300))
			expect(viewText(terminal)).not.toContain("(thinking…)")
		},
	)
})

/**
 * Defensive coverage: a pure-text turn (no reasoning) must not render the
 * "(thinking…)" suffix. The cooking frame may show during the message_start
 * → text_start gap, but the suffix only renders when thinkingStatus is set.
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

			await new Promise((resolve) => setTimeout(resolve, 200))
			const full = fullText(terminal)
			expect(full).not.toContain("(thinking…)")
			expect(full).not.toContain("(thought for")
			trace.step("no (thinking…) suffix for plain-text responses")
		},
	)
})
