import { expect, test } from "@microsoft/tui-test"
import {
	fullText,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("--ferment-oneshot uses scoping without opening interactive plan approval", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "oneshot-bypasses-dropdown",
			gitInit: true,
			responses: [
				{
					stream: [],
					toolCalls: [
						{
							function: {
								name: "scope_ferment",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									title: "Add API Endpoint",
									goal: "Add a new API endpoint.",
									success_criteria: ["The endpoint responds to its documented request."],
									constraints: ["Preserve the existing API."],
									phases: [
										{
											name: "Implement endpoint",
											goal: "Implement and verify the endpoint.",
											steps: [{ description: "Create the route handler.", verify: "test -f src/route.ts" }],
										},
									],
									gates: [
										{
											id: "P1",
											verdict: "pass",
											rationale: "The route has a direct verification command.",
											evidence: "test -f src/route.ts",
										},
										{ id: "P2", verdict: "omitted", rationale: "There is one sequential phase.", evidence: "n/a" },
										{
											id: "P3",
											verdict: "pass",
											rationale: "The endpoint behavior is covered by the success criterion.",
											evidence: "success_criteria[0]",
										},
									],
								}),
							},
						},
					],
				},
				{ stream: ["Scope recorded; continuing one-shot execution.\n"] },
			],
			extraArgs: ["--ferment-oneshot=true"],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("one-shot session ready")

			terminal.submit("Add a new API endpoint")
			trace.step("submitted one-shot intent")
			await waitForText(terminal, "Scope recorded; continuing one-shot execution.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)

			expect(
				fixture.fake.requests.some((request) => (JSON.stringify(request.body) ?? "").includes("scope_ferment")),
			).toBe(true)
			trace.step("scope_ferment completed without interactive approval")

			await new Promise((resolve) => setTimeout(resolve, 1_000))
			const text = fullText(terminal)
			for (const label of [
				"Execute the plan",
				"Rework the plan",
				"Start as ferment",
				"How would you like to proceed?",
			]) {
				expect(text.includes(label)).toBe(false)
			}
			trace.step("no interactive plan approval dropdown appeared or stalled")
		},
	)
})
