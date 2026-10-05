import { execFileSync } from "node:child_process"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests, systemPromptOf } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("gh/glab guidance ships as eager behaviours triggered by the repo remote", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "gh-glab-behaviours-eager",
			gitInit: true,
			seedHome: (_homeDir, workDir) => {
				// The gh-cli behaviour's session trigger is a github.com remote.
				execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], { cwd: workDir })
			},
			responses: [{ stream: ["Acknowledged."], responseModel: "kimi-k3" }],
		},
		async (fixture, trace) => {
			terminal.submit("hello")
			await waitForText(terminal, "Acknowledged.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first turn settled")

			const chat = chatRequests(fixture)
			expect(chat.length).toBeGreaterThan(0)
			const prompt = systemPromptOf(chat[0])

			// The gh behaviour body is injected eagerly: the session trigger is
			// the github.com remote seeded above. Its non-obvious markers ride
			// in the system prompt from turn one — no skill read required.
			expect(prompt).toContain("resolveReviewThread")
			expect(prompt).toContain("gh pr review <N> --approve")

			// The glab behaviour fires on its own triggers (gitlab remote or a
			// glab CLI on PATH) — machine-dependent, so not asserted here.

			// And neither ships as a bundled skill anymore.
			expect(prompt).not.toContain("**gh-cli**")
			expect(prompt).not.toContain("**glab-cli**")
		},
	)
})
