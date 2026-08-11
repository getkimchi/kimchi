import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { type KimchiFixture, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const REVIEW_NUDGE = "The direct-edit allowance is only for one trivial fix requiring up to two small edit/write calls"

function writeResponse(id: string, message: string) {
	return {
		stream: [message],
		toolCalls: [
			{
				id: `call_${id}`,
				function: {
					name: "write",
					arguments: JSON.stringify({ path: `${id}.txt`, content: `${message}\n` }),
				},
			},
		],
	}
}

function maxDeliveredNudges(fixture: KimchiFixture): number {
	return Math.max(
		0,
		...fixture.fake.requests.map((request) => JSON.stringify(request.body ?? "").split(REVIEW_NUDGE).length - 1),
	)
}

test("each build-review cycle renews the two-fix allowance and nudge", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "review-write-guard-nudge",
			responses: [
				writeResponse("initial-build", "Applying initial build work."),
				{ stream: ["Initial build completed."] },
				writeResponse("first-review-fix-1", "Applying first review fix 1."),
				writeResponse("first-review-fix-2", "Applying first review fix 2."),
				{ stream: ["First review fixes completed after the delegation reminder."] },
				writeResponse("second-build", "Applying second build work."),
				{ stream: ["Second build completed."] },
				writeResponse("second-review-fix-1", "Applying second review fix 1."),
				writeResponse("second-review-fix-2", "Applying second review fix 2."),
				{ stream: ["Second review fixes completed after the delegation reminder."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("/phase build")
			await waitForText(terminal, "Phase changed to: build", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Apply the scripted initial build work")
			await waitForText(terminal, "Initial build completed.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("initial build phase observed by the guard")

			terminal.submit("/phase review")
			await waitForText(terminal, "Phase changed to: review", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Apply the first two scripted review fixes")
			await waitForText(terminal, "First review fixes completed after the delegation reminder.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(maxDeliveredNudges(fixture)).toBe(1)
			trace.step("first review cycle delivered one nudge after two fixes")

			terminal.submit("/phase build")
			await waitForText(terminal, "Phase changed to: build", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Apply the scripted second build work")
			await waitForText(terminal, "Second build completed.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("intervening build phase reset the review guard")

			terminal.submit("/phase review")
			await waitForText(terminal, "Phase changed to: review", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Apply the second two scripted review fixes")
			await waitForText(terminal, "Second review fixes completed after the delegation reminder.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(maxDeliveredNudges(fixture)).toBe(2)
			trace.step("second review cycle renewed the allowance and delivered a second nudge")
		},
	)
})
