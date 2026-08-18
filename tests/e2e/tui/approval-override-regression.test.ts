import { expect, test } from "@microsoft/tui-test"
import { waitForTurnToSettle } from "./support/assertions.js"
import type { RecordedRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool"
const ASSISTANT_QUESTION = "Go ahead and commit this small ADR update?"

function requestBodyText(request: RecordedRequest): string {
	return JSON.stringify(request.body ?? "")
}

function findQuestionRequestIndex(requests: RecordedRequest[]): number {
	return requests.findIndex((r) => requestBodyText(r).includes(ASSISTANT_QUESTION))
}

function anyLaterRequestContains(requests: RecordedRequest[], startIndex: number, text: string): boolean {
	for (let i = startIndex + 1; i < requests.length; i++) {
		if (requestBodyText(requests[i]).includes(text)) return true
	}
	return false
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
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("turn settled")

			const questionIndex = findQuestionRequestIndex(fixture.fake.requests)
			expect(questionIndex).toBeGreaterThanOrEqual(0)

			// The core regression: no continuation nudge should be injected after
			// the assistant asks a question.
			expect(anyLaterRequestContains(fixture.fake.requests, questionIndex, CONTINUATION_NUDGE_PHRASE)).toBe(false)

			// And therefore no unauthorized git commit/push tool calls should
			// appear in any later request.
			const laterRequests = fixture.fake.requests.slice(questionIndex + 1)
			for (const request of laterRequests) {
				const text = requestBodyText(request)
				expect(text).not.toContain("git commit")
				expect(text).not.toContain("git push")
			}
		},
	)
})
