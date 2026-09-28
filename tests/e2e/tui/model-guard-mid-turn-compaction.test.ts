/**
 * E2E TUI test: the non-ferment mid-turn compaction workflow.
 *
 * A plain tool chain crosses the context-compaction threshold mid-run
 * (turn 2 reports usage above window − 16,384). model-guard compacts inside
 * the awaited turn_end handler via the inline adapter, so the SAME run
 * continues: the user sees the compaction notice, the remaining tool turns
 * run without another prompt, and the final answer is displayed. The next
 * request on the wire carries the summary marker instead of the old filler.
 *
 * This is the interactive twin of tests/smoke/print-mid-turn-compaction.test.ts:
 * print mode proves the awaited-prompt lifecycle; this test proves the
 * user-visible workflow (no "Continue to resume" dead end, no manual resend).
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const SUMMARY_MARKER = "TUI_C0MPACT_SUMMARY_MARKER_x9"
const FILLER_TOKEN = "TUI_F1LLER_UN1QUE_5e"
const FILLER_TEXT = `${FILLER_TOKEN} turn-one working notes.`
/** The kept tail must exceed upstream's default keepRecentTokens (20,000) so
 *  the compaction cut lands at this turn, not inside the filler turn. */
const RECENT_TEXT = `recent-context turn-two notes. ${"kept note ".repeat(9_000)}`
const FINAL_ANSWER = "TUI_FINAL_ANSWER_2f: all work complete"
const PROMPT = "Run the three bash echo steps in order, then state the final answer."

/** Upstream's compaction makes two kinds of summarization LLM calls: the
 *  regular history summary and, when the cut lands mid-turn (single-turn tool
 *  chains — the cut point is an assistant message), the split-turn prefix
 *  summary. Both identify "the summary request". */
function isSummarizationRequest(body: unknown): boolean {
	const text = JSON.stringify(body ?? "")
	return (
		text.includes("structured context checkpoint summary") ||
		text.includes("PREFIX of a turn that was too large to keep")
	)
}

test("a tool task compacts mid-run and finishes without another prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-guard-mid-turn-compaction",
			gitInit: true,
			// Large context window keeps the mid-turn threshold (262,144 −
			// 16,384 = 245,760) below the scripted turn-2 usage (250,700).
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [
				// Turn 1: filler + first tool call — below threshold, no trigger.
				{
					stream: [FILLER_TEXT],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo tui-turn-one" }) } }],
					usage: { prompt_tokens: 30_000, completion_tokens: 500 },
				},
				// Turn 2: large kept-tail content + second tool call — crosses the
				// threshold; the turn_end guard fires here.
				{
					stream: [RECENT_TEXT],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo tui-turn-two" }) } }],
					usage: { prompt_tokens: 250_000, completion_tokens: 700 },
				},
				// The compaction summarization call — for a single-turn tool chain
				// it is the split-turn prefix summary.
				{
					match: (request) => isSummarizationRequest(request.body),
					stream: [`${SUMMARY_MARKER}: the tool task is mid-flight; work continues.`],
					usage: { prompt_tokens: 1_000, completion_tokens: 200 },
				},
				// Turn 3 (post-compaction): below threshold, no further compaction.
				{
					stream: ["Continuing after compaction."],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo tui-turn-three" }) } }],
					usage: { prompt_tokens: 20_000, completion_tokens: 200 },
				},
				// Final answer.
				{ stream: [FINAL_ANSWER], usage: { prompt_tokens: 21_000, completion_tokens: 100 } },
				// Keepalive for any reactive nudge afterwards.
				{},
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: submit the tool task — the only user input of the session.
			terminal.submit(PROMPT)
			await waitForText(terminal, "tui-turn", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("tool task submitted")

			// Stage 3: the guard's compaction notice appears mid-run…
			await waitForText(terminal, "Context compacted", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("compaction notice visible")

			// Stage 4: …and the SAME run finishes with the final answer — no
			// second prompt, no manual "Continue to resume".
			await waitForText(terminal, FINAL_ANSWER, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("final answer visible without another prompt")

			// Assert on the recorded request bodies: exactly one summarization
			// call, and the post-compaction task requests carry the summary
			// marker, not the old filler.
			const chatRequests = fixture.fake.requests.filter((request) =>
				request.url.startsWith("/openai/v1/chat/completions"),
			)
			const summaryRequests = chatRequests.filter((request) => isSummarizationRequest(request.body))
			const taskRequests = chatRequests.filter((request) => !isSummarizationRequest(request.body))

			expect(summaryRequests.length).toBe(1)

			// Sanity: the filler really was on the wire before compaction.
			expect(JSON.stringify(taskRequests[1].body)).toContain(FILLER_TOKEN)

			const lastBody = JSON.stringify(taskRequests[taskRequests.length - 1].body)
			expect(lastBody).toContain(SUMMARY_MARKER)
			expect(lastBody).not.toContain(FILLER_TOKEN)
			trace.step("post-compaction request carries summary marker and not the filler blob")
		},
	)
})
