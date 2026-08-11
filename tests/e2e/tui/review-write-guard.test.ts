import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const REVIEW_NUDGE = "The direct-edit allowance is only for one trivial fix requiring up to two small edit/write calls"

function writeResponse(index: number) {
	return {
		stream: [`Applying review fix ${index}.`],
		toolCalls: [
			{
				id: `call_review_write_${index}`,
				function: {
					name: "write",
					arguments: JSON.stringify({ path: `review-fix-${index}.txt`, content: `fix ${index}\n` }),
				},
			},
		],
	}
}

test("review allows two small fixes and nudges after the third", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "review-write-guard-nudge",
			responses: [
				writeResponse(1),
				writeResponse(2),
				writeResponse(3),
				{ stream: ["Review fixes completed after the delegation reminder."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("/phase review")
			await waitForText(terminal, "Phase changed to: review", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("entered review phase")

			terminal.submit("Apply the three scripted review fixes")
			trace.step("submitted review-fix workflow")
			await waitForText(terminal, "Review fixes completed after the delegation reminder.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("all three fixes completed without a hard block")

			const requestsAfterNudge = fixture.fake.requests.filter((request) =>
				JSON.stringify(request.body ?? "").includes(REVIEW_NUDGE),
			)
			expect(requestsAfterNudge).toHaveLength(1)
			trace.step("third review write delivered one delegation nudge to the next model turn")
		},
	)
})
