import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const councilEnv = {
	KIMCHI_COUNCIL_ENABLED: "true",
	KIMCHI_COUNCIL_LEAD_MODEL: "fake/basic",
	KIMCHI_COUNCIL_LEAD_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_INDEPENDENT_MODEL: "fake/basic",
	KIMCHI_COUNCIL_INDEPENDENT_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_CRITIC_MODEL: "fake/basic",
	KIMCHI_COUNCIL_CRITIC_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_CHECKER_MODEL: "fake/basic",
	KIMCHI_COUNCIL_CHECKER_FALLBACK_MODELS: "",
	KIMCHI_COUNCIL_JUDGE_MODEL: "fake/basic",
	KIMCHI_COUNCIL_JUDGE_FALLBACK_MODELS: "",
}

test("Council is selectable and returns a reviewed answer through the TUI", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "council-model",
			env: councilEnv,
			extraArgs: ["--provider", "kimchi", "--model", "council-fast"],
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 8_192 }],
			responses: [
				{ stream: ["Reviewed", " Council", " answer."], delayMs: 25 },
				{
					stream: [
						JSON.stringify({
							schema_version: 1,
							role: "critic",
							decision: "accept",
							findings: [],
							recommended_changes: [],
							missing_evidence: [],
							challenged_assumptions: [],
							counterexamples: [],
							affected_claims: [],
						}),
					],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Give me a short verified answer")
			trace.step("submitted Council prompt")

			await expect(terminal.getByText("Reviewed Council answer.", { full: true })).toBeVisible()
			trace.step("reviewed answer rendered")

			const reviewerCall = fixture.fake.requests.find((request) =>
				JSON.stringify(request.body ?? "").includes("You are a Council reviewer"),
			)
			expect(reviewerCall).toBeDefined()
		},
	)
})
