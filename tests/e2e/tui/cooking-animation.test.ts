import { expect, test } from "@microsoft/tui-test"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { STREAM_TIMEOUT_MS, fullText, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * E2E coverage for the cooking animation's behavior across an assistant
 * turn: it must stay visible during reasoning and while text streams,
 * appear during plain-text (non-thinking) responses, stay visible during
 * tool execution and the gap before the next message, be hidden while an
 * interactive questionnaire form has focus, and surface a "Worked for Xs"
 * message at turn end.
 *
 * The indicator lifecycle is intentionally simple: it starts at turn_start
 * and stops at message_end / turn_end / agent_end. tool_execution_end is a
 * no-op — the indicator keeps running through the tool-result gap because
 * the turn is still active. The only exception is interactive prompts
 * (questionnaire, ask_user, permission prompts) which hide the indicator
 * via setWorkingVisible(false) while the form has keyboard focus.
 *
 * Tests that exercise the reasoning code path opt into a
 * reasoning-capable fake model (see `runSession`) so they exercise the
 * actual reasoning code rather than relying on the fake server emitting
 * reasoning_content chunks that the upstream provider would be free to
 * ignore on a non-reasoning model.
 */

const COOKING_FRAME = /(Stirring|Marinating|Chopping)/

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

test("cooking animation stays visible during reasoning and while text streams", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-thinking",
			useThinkingModel: true,
			responses: [
				{
					// Spaced reasoning chunks give the animator's setInterval time to
					// tick and render a cooking frame before text arrives.
					thinking: ["Let me ", "think ", "about ", "this ", "carefully."],
					thinkingDelayMs: 250,
					// Slow text chunks so the indicator is observable while text streams.
					stream: ["The ", "answer ", "is ", "4."],
					textDelayMs: 300,
				},
			],
		},
		async (trace) => {
			terminal.submit("What is 2+2?")
			trace.step("submitted prompt")

			// The cooking animation is visible during reasoning.
			await waitForText(terminal, COOKING_FRAME, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking animation visible during reasoning")

			// Wait for the first text chunks to appear — text_start has fired.
			await waitForText(terminal, "The answer", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first text chunks rendered")

			// The indicator must still be running now that text is streaming.
			// (Before the fix, text_start stopped the indicator immediately.)
			await waitForText(terminal, COOKING_FRAME, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking animation still visible while text streams")

			await waitForText(terminal, "The answer is 4.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("full response text rendered")

			// No "(thinking…)" / "(thought for" suffix is ever rendered.
			const view = viewText(terminal)
			expect(view).not.toContain("(thinking…)")
			expect(view).not.toContain("(thought for")
			expect(view).toContain("The answer is 4.")
			trace.step("no thinking suffix present")
		},
	)
})

test("cooking animation is visible during the gap before the first reasoning delta", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-thinking-gap",
			useThinkingModel: true,
			responses: [
				{
					// 800ms delay widens the pre-thinking gap; the animator has time
					// to tick and render a cooking frame before thinking_start fires.
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
			await waitForText(terminal, COOKING_FRAME, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking frame visible during pre-thinking gap")

			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response rendered")
		},
	)
})

test("cooking animation is visible during plain-text responses", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-plain-text",
			// Slow text so the cooking frame is observable mid-stream.
			responses: [{ stream: ["Just plain ", "text."], textDelayMs: 200 }],
		},
		async (trace) => {
			terminal.submit("Reply without thinking")
			trace.step("submitted prompt")

			// The cooking animation runs for non-thinking models too — the
			// indicator starts at turn_start and stays until message_end.
			await waitForText(terminal, COOKING_FRAME, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking frame visible during plain-text response")

			await waitForText(terminal, "Just plain text.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("response rendered")

			// No thinking suffix is ever rendered (regression guard for the
			// removed "(thinking…)" / "(thought for Ns)" suffixes).
			const full = fullText(terminal)
			expect(full).not.toContain("(thinking…)")
			expect(full).not.toContain("(thought for")
			trace.step("no thinking suffix present")
		},
	)
})

test("cooking animation stays visible during tool execution and the gap before the next message", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-tool-execution",
			responses: [
				// First response: model emits a brief orientation text before calling
				// bash. The tool's execution time keeps the spinner visible long enough
				// to observe.
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
			await waitForText(terminal, COOKING_FRAME, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("cooking animation visible during tool execution")

			// tool_execution_end is a no-op — the indicator keeps running through
			// the tool-result gap until the next message_end. "Tool done."
			// rendering confirms the tool-result round-trip worked.
			await waitForText(terminal, "Tool done.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("tool result + final response rendered")
		},
	)
})

test("cooking animation is hidden while a questionnaire form is shown and restored after answering", async ({ terminal }) => {
	await runSession(
		terminal,
		{
			artifactName: "cooking-animation-questionnaire",
			responses: [
				// Turn 1: model streams text, then calls the questionnaire tool.
				// Slow text so the Enter from submit is fully consumed before
				// the tool call fires (a single-question form auto-submits on
				// one Enter — a leaked keystroke would dismiss it instantly).
				{
					stream: ["Let me ask you something."],
					textDelayMs: 200,
					toolCalls: [
						{
							id: "call_questionnaire",
							function: {
								name: "questionnaire",
								arguments: JSON.stringify({
									questions: [
										{
											id: "choice",
											type: "single",
											prompt: "Pick one:",
											options: [
												{ id: "a", label: "Option A" },
												{ id: "b", label: "Option B" },
											],
										},
									],
								}),
							},
						},
					],
				},
				// Turn 2: slow follow-up so the cooking frame is observable
				// during streaming after the form closes.
				{ stream: ["Great ", "choice!"], textDelayMs: 300 },
			],
		},
		async (trace) => {
			terminal.submit("Ask me a question")
			trace.step("submitted prompt")

			// Wait for the model's streaming text first. This consumes the Enter
			// from submit before the tool call fires, so it can't leak into the
			// questionnaire form and auto-select an option.
			await waitForText(terminal, "Let me ask you something.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model streaming text before tool call")

			// Wait for the questionnaire form to appear — question text + options.
			await waitForText(terminal, "Pick one:", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Option A", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("questionnaire form visible")

			// The cooking animation must be hidden while the form has focus
			// (setWorkingVisible(false) is called before ctx.ui.custom).
			// Allow a brief render tick for the hide to take effect.
			await new Promise((resolve) => setTimeout(resolve, 300))
			expect(viewText(terminal)).not.toMatch(COOKING_FRAME)
			trace.step("cooking animation hidden while questionnaire form is shown")

			// Select the first option (Option A) by pressing Enter.
			terminal.submit("")
			trace.step("selected Option A")

			// The follow-up response renders — proving the form was dismissed
			// and the turn continued. The indicator is restored
			// (setWorkingVisible(true) in the finally block) — that's covered
			// precisely by the unit test asserting the call order.
			await waitForText(terminal, "Great choice!", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up response rendered after questionnaire answered")
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
