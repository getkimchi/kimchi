import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests, systemPromptOf, toolDescriptionOf } from "./support/wire-requests.js"

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

			// The intentionally replaced built-in must not emit Pi's generic
			// extension-conflict warning on every startup.
			expect(fullText(terminal).replace(/\s+/g, " ")).not.toContain("built-in extension `codemode` was not loaded")

			const chat = chatRequests(fixture)
			expect(chat.length).toBeGreaterThan(0)
			const prompt = systemPromptOf(chat[0])

			// Interactive (user-loop) sections present.
			expect(prompt).toContain("## Consent & Irreversible Actions")
			expect(prompt).toContain("## Harness Notes and Approval")
			expect(prompt).toContain("## Documents")
			expect(prompt).toContain("orients the user")
			expect(prompt).toContain("## Working Practices")

			// Codemode's selection rule reaches the model through both Tool
			// Selection and the dynamic function declaration.
			expect(prompt).toContain("Use `codemode` when intermediate output can be filtered before it reaches you")
			const codemodeDescription = toolDescriptionOf(chat[0], "codemode")
			// Exactly once: pi's built-in codemode is replaced, not stacked.
			expect(codemodeDescription?.split("Use to filter large results before they reach you")).toHaveLength(2)
			expect(codemodeDescription).not.toContain("const hits")
			expect(prompt).not.toContain("Use read to examine files instead of cat or sed.")
			expect(prompt).not.toContain("Use codemode to batch independent tool calls (Promise.allSettled),")

			// The headless replacement never appears in an interactive session.
			expect(prompt).not.toContain("## Autonomous Session")
		},
	)
})
