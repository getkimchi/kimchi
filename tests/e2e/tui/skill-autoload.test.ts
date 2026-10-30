import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("a prompt naming a .pdf file auto-loads the pdf skill before the first inference", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-autoload-pdf",
			responses: [{ stream: ["Acknowledged."], responseModel: "kimi-k3" }],
		},
		async (fixture, trace) => {
			terminal.submit("read ~/runbook-q4.pdf and summarize it in two lines")
			await waitForText(terminal, "Acknowledged.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first turn settled")

			// The keyword trigger must fire deterministically: exactly one chat
			// request happened, and it already carried the pdf skill body as a
			// steer — the model never had to call skill_view first.
			const chat = chatRequests(fixture)
			expect(chat.length).toBe(1)
			const messages = JSON.stringify((chat[0].body as { messages?: unknown[] }).messages ?? [])
			expect(messages).toContain("auto-loaded because the prompt matched its declared trigger (ext:.pdf)")
			expect(messages).toContain("Skill directory:")
			expect(messages).toContain("dump-shapes")
		},
	)
})

test("a keyword-only prompt (no file name) auto-loads the pdf skill too", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "skill-autoload-keyword",
			responses: [{ stream: ["Acknowledged."], responseModel: "kimi-k3" }],
		},
		async (fixture, trace) => {
			terminal.submit("summarize the attached pdf in two lines")
			await waitForText(terminal, "Acknowledged.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("first turn settled")

			const chat = chatRequests(fixture)
			expect(chat.length).toBe(1)
			const messages = JSON.stringify((chat[0].body as { messages?: unknown[] }).messages ?? [])
			expect(messages).toContain("auto-loaded because the prompt matched its declared trigger (kw:pdf)")
			expect(messages).toContain("dump-shapes")
		},
	)
})
