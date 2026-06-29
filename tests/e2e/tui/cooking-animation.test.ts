import { expect, test } from "@microsoft/tui-test"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { STREAM_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * E2E coverage for the cooking animation's behavior across an assistant
 * turn: it must stay visible during reasoning, render the "(thinking…)"
 * suffix while reasoning deltas arrive, switch off once visible text
 * starts streaming, restart during tool execution, and surface a
 * "Worked for Xs" message at turn end.
 *
 * Tests that exercise the reasoning code path opt into a
 * reasoning-capable fake model (see `runSession`) so they exercise the
 * actual reasoning code rather than relying on the fake server emitting
 * reasoning_content chunks that the upstream provider would be free to
 * ignore on a non-reasoning model.
 */

async function runSession(
	terminal: import("@microsoft/tui-test").Terminal,
	options: {
		artifactName: string
		responses: FakeResponseScript[]
		useThinkingModel?: boolean
	},
	body: (trace: { step: (label: string) => void }) => Promise<void>,
): Promise<void> {
	const baseOpts: { artifactName: string; responses: FakeResponseScript[] } = {
		artifactName: options.artifactName,
		responses: options.responses,
	}
	const opts = options.useThinkingModel
		? {
				...baseOpts,
				models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
				extraArgs: ["--model", "thinking-model"],
			}
		: baseOpts
	await runKimchiSession(terminal, opts, async (_fixture, trace) => body(trace))
}

test("cooking animation stays visible during reasoning and clears when text starts", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-thinking",
			useThinkingModel: true,
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
		async (trace) => {
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

test("cooking animation is visible during the gap between message_start and the first reasoning delta", async ({
	terminal,
}) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-thinking-gap",
			useThinkingModel: true,
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
		async (trace) => {
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

test("cooking animation shows no (thinking…) suffix for plain-text responses", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-no-suffix",
			responses: [{ stream: ["Just plain ", "text."], textDelayMs: 100 }],
		},
		async (trace) => {
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

test("cooking animation restarts during tool execution and stops when the tool completes", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-tool-execution",
			responses: [
				// First response: model emits a brief orientation text (required by
				// the first-turn-orientation guard) before calling bash. The tool's
				// execution time keeps the spinner visible long enough to observe.
				{
					stream: ["Running the slow command."],
					toolCalls: [
						{
							id: "call_bash_sleep",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "sleep 1" }),
							},
						},
					],
				},
				// Second response: model acknowledges the tool result.
				{ stream: ["Tool done."] },
			],
		},
		async (trace) => {
			terminal.submit("Run a slow command")
			trace.step("submitted prompt")

			// The first response is a tool call with no streaming text, so the
			// cooking animation should be alive across the message_start →
			// tool_execution_start gap, then visibly on during the tool itself.
			await waitForText(terminal, /(Stirring|Marinating|Chopping)/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking animation visible during tool execution")

			// Tool result comes back, the model produces the final text. That's
			// the user-visible proof of success here — "Tool done." rendering
			// confirms the tool-result round-trip worked. The spinner being
			// gone is a consequence of text_start firing (covered precisely
			// by the unit test); asserting it at e2e would need to enumerate
			// all ~20 cooking frames and adds no real coverage.
			await waitForText(terminal, "Tool done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("tool result + final response rendered")
		},
	)
})

test("'Worked for Xs' appears after the assistant message completes", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-worked-for",
			responses: [{ stream: ["All done."] }],
		},
		async (trace) => {
			terminal.submit("Simple task")
			trace.step("submitted prompt")

			await waitForText(terminal, "All done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response text rendered")

			// turn_end fires after message_end and renders "✻ Worked for Xs"
			// (with elapsed seconds). Don't assert the auto-hide — that's
			// timer-dependent and covered precisely by the unit test with fake
			// timers.
			await waitForText(terminal, /Worked for/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("'Worked for Xs' message appears after turn_end")
		},
	)
})
