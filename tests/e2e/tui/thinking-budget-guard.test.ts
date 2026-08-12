import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Behavioural spec for the thinking budget guard (Chunk 1 of the
 * deliberation-overhead token work): a turn that spends its whole output on
 * reasoning and never calls a tool gets a steering injection, and the very
 * next turn must take action.
 *
 * The fake provider first emits a >80K-char thinking-only turn (the
 * pathological talk-only mega-think shape from terminal-bench trajectories).
 * The guard's steer is sent with display:false, so it never renders in the
 * terminal — what renders instead is its effect: the next assistant turn
 * calls the bash tool and the marker output appears. The steer itself is
 * asserted on the wire: the follow-up provider request must carry the
 * "Thinking budget guard" text in the conversation it receives.
 */
const MEGA_THINK_CHARS = 100_000

test("talk-only mega-think turn is steered into a tool call on the next turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "thinking-budget-guard",
			// Reasoning-capable model so reasoning_content maps to thinking blocks.
			models: [
				{
					slug: "thinking-model",
					displayName: "Fake Thinking",
					reasoning: true,
					contextWindow: 8_000_000,
					maxTokens: 64_000,
				},
			],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				// Turn 1: thinking-only mega-turn, stop, no tool call — guard fires.
				{ thinking: ["x".repeat(MEGA_THINK_CHARS)] },
				// Turn 2 (post-steer): the model acts — bash output proves the turn had a tool call.
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo GUARD_STEERED_INTO_ACTION" }),
							},
						},
					],
				},
				// Turn 3 (post-tool-result): wrap up.
				{ stream: ["Task complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("solve the task")
			trace.step("submitted prompt")

			// The steer injection never renders (display:false); its effect does:
			// the next turn's bash call runs and the marker output appears.
			await waitForText(terminal, "GUARD_STEERED_INTO_ACTION", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("tool output from the post-steer turn visible")

			// The steer must have been delivered to the model: some request after
			// the first carries the guard text in its message history.
			const requestPayloads = fixture.fake.requests.map((request) => JSON.stringify(request.body ?? ""))
			expect(requestPayloads.some((payload) => payload.includes("Thinking budget guard"))).toBe(true)
			trace.step("steer text present in a subsequent provider request")
		},
	)
})
