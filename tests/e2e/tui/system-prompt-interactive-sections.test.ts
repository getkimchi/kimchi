import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests, systemPromptOf } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("interactive TUI sessions keep Consent, Harness Notes, Documents and the orient ritual", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "system-prompt-interactive-sections",
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

			// Interactive (user-loop) sections present.
			expect(prompt).toContain("## Consent & Irreversible Actions")
			expect(prompt).toContain("## Harness Notes and Approval")
			expect(prompt).toContain("## Documents")
			expect(prompt).toContain("orients the user")
			expect(prompt).toContain("## Phase Management")

			// The replacement prompt keeps upstream tool guidance and explains
			// when batching through codemode is preferable to direct calls.
			expect(prompt).toContain("## Tool Guidelines")
			expect(prompt).toContain("Use codemode to batch independent tool calls (Promise.allSettled)")
			expect(prompt).toContain("Prefer `codemode` for batching independent tool calls")

			// The headless replacement never appears in an interactive session.
			expect(prompt).not.toContain("## Autonomous Session")
		},
	)
})
