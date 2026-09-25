import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests, systemPromptOf } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("gh-cli/glab-cli ship as cataloged bundled skills, not eager prompt bodies", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "gh-glab-skills-catalog-only",
			responses: [{ stream: ["Acknowledged."] }],
		},
		async (fixture, trace) => {
			terminal.submit("hello")
			await waitForText(terminal, "Acknowledged.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first turn settled")

			const chat = chatRequests(fixture)
			expect(chat.length).toBeGreaterThan(0)
			const prompt = systemPromptOf(chat[0])

			// The skills catalog advertises both skills with their descriptions —
			// that entry is the only standing prompt surface for the CLIs.
			expect(prompt).toContain("## Skills")
			expect(prompt).toContain("**gh-cli**")
			expect(prompt).toContain("GitHub CLI")
			expect(prompt).toContain("**glab-cli**")
			expect(prompt).toContain("GitLab CLI")
			// Codex-style markdown catalog: no XML tags in the prompt.
			expect(prompt).not.toContain("<available_skills>")

			// The eager body content is gone from the prompt — it enters context
			// only when the agent reads the skill file.
			expect(prompt).not.toContain("resolveReviewThread")
			expect(prompt).not.toContain("gh pr review <N> --approve")
			expect(prompt).not.toContain("glab mr note resolve")
		},
	)
})
