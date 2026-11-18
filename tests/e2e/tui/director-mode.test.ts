import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { requestToolNames } from "./support/request-tools.js"
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("Director stop returns immediately to normal chat", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "director-stop-only",
			responses: [{ stream: ["Director active."] }, { stream: ["Normal chat."] }],
		},
		async () => {
			terminal.submit("/skill:director demo objective")
			await waitForText(terminal, "Director active.", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("/director stop\r")
			terminal.write("return to normal work\r")
			await waitForText(terminal, "Normal chat.", { timeoutMs: STREAM_TIMEOUT_MS })
		},
	)
})

test("explicit Director activation is visible and restricted until stop restores normal chat tools", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "director-lifecycle",
			responses: [
				{ stream: ["Director active."] },
				{ stream: ["Steering continues."] },
				{ stream: ["Normal chat."] },
				{ stream: ["Second Director active."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("/skill:director demo objective")
			await waitForText(terminal, "Director active.", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("/director status")
			await waitForText(terminal, "Tasks:", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("Direct plan is visible, now check the persistent indicator")
			await waitForText(terminal, "Director — demo objective", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("Director activated with a persistent indicator")

			terminal.submit("continue with this objective")
			await waitForText(terminal, "Steering continues.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const activeTools = requestToolNames(chatRequests(fixture).at(-1) ?? {})
			const allowed = new Set([
				"Agent",
				"resume_subagent",
				"steer_subagent",
				"get_subagent_result",
				"questionnaire",
				"skill_view",
				"director_plan",
				"director_finish",
			])
			for (const name of activeTools) expect(allowed.has(name)).toBe(true)
			// Existing agent deferral hides continuation tools until the first worker exists.
			expect(activeTools).toContain("Agent")
			expect(activeTools).toContain("director_plan")
			expect(activeTools).toContain("director_finish")

			terminal.write("/director stop\r")
			terminal.write("return to normal work\r")
			await waitForText(terminal, "Normal chat.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const restoredTools = requestToolNames(chatRequests(fixture).at(-1) ?? {})
			expect(restoredTools).toContain("read")
			expect(restoredTools).not.toContain("director_plan")

			terminal.submit("/skill:director second objective")
			await waitForText(terminal, "Second Director active.", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("/director status")
			await waitForText(terminal, "Director active: second objective")
			trace.step("Status can be read in the second run")
			terminal.write("/director stop\r")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(fullText(terminal)).not.toContain("Director —")
		},
	)
})
