import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { RecordedRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool"
const ASSISTANT_QUESTION = "Go ahead and commit this small ADR update?"

function requestBodyText(request: RecordedRequest): string {
	return JSON.stringify(request.body ?? "")
}

/**
 * Regression test for the approval-override incident (Session A).
 *
 * Timeline:
 *   1. User asks the model to do some work.
 *   2. Model makes a tool call (so the continuation nudge's session-level
 *      tool-call gate is satisfied).
 *   3. After the tool result, the model asks the user a confirmation question
 *      ("Go ahead and commit this small ADR update?") and ends its turn.
 *
 * Before the fix, the continuation nudge fired after the text-only question
 * turn and was misread as user approval, causing the model to commit and push
 * without explicit consent.
 *
 * With the fix, the nudge is suppressed when the assistant's text ends with a
 * question, so no follow-up request containing the nudge phrase is sent and no
 * commit/push tool calls appear.
 */
test("continuation nudge is suppressed after an unanswered assistant question", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "approval-override-regression",
			gitInit: true,
			responses: [
				// Turn 1: model does some work with a tool call.
				{
					stream: [],
					toolCalls: [
						{
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "README.md" }),
							},
						},
					],
					finishReason: "tool_calls",
				},
				// Turn 2: after the tool result, the model asks for confirmation
				// instead of calling commit/push itself.
				{
					stream: [ASSISTANT_QUESTION],
					finishReason: "stop",
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("draft a small ADR update")
			trace.step("submitted prompt")

			// Wait until the assistant's confirmation question is rendered in the
			// terminal, then wait for the harness to settle (no further requests).
			await waitForText(terminal, ASSISTANT_QUESTION)
			trace.step("assistant question rendered")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn settled")

			// The core regression: no continuation nudge should be injected after
			// the assistant asks a question.
			for (const request of fixture.fake.requests) {
				expect(requestBodyText(request)).not.toContain(CONTINUATION_NUDGE_PHRASE)
			}
		},
	)
})
