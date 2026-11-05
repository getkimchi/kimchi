import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Regression guard: exported sessions must carry the harness system prompt,
 * not pi's base prompt.
 *
 * pi 1.3.0 delivers the before_agent_start `systemPrompt` result as a
 * per-run forceSystemPrompt projection that is never recorded in the
 * transcript — so both export surfaces (JSONL header, HTML payload) used to
 * snapshot pi's base prompt ("You are an expert coding assistant operating
 * inside pi, a coding agent harness…"). The fix captures the finalized
 * prompt per-session at agent_start (via ctx.getSystemPrompt(), after all
 * before_agent_start handlers — including hook-adapter appends — have
 * merged into the run options) and injects it at export time; this test
 * fails if a future pi upgrade changes prompt persistence again.
 */
test("exported sessions carry Kimchi's system prompt, not pi's base prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "export-system-prompt",
			responses: [{ stream: ["Reply complete."] }],
		},
		async (fixture, trace) => {
			// One real turn so before_agent_start fires and the harness prompt
			// is captured for this session.
			terminal.submit("Say hello")
			await waitForText(terminal, "Reply complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("assistant turn completed — prompt captured")

			const jsonlPath = join(fixture.workDir, "exported-session.jsonl")
			const htmlPath = join(fixture.workDir, "exported-session.html")

			terminal.submit(`/export ${jsonlPath}`)
			await waitForText(terminal, "exported-session.jsonl", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("JSONL export completed")

			const header = JSON.parse(
				readFileSync(jsonlPath, "utf-8")
					.split("\n")
					.filter((line) => line.trim().length > 0)[0],
			) as { systemPrompt?: string }
			expect(header.systemPrompt).toContain("You are Kimchi, an AI coding agent by CAST AI")
			expect(header.systemPrompt).not.toContain("operating inside pi, a coding agent harness")
			trace.step("JSONL header carries the harness prompt")

			terminal.submit(`/export ${htmlPath}`)
			await waitForText(terminal, "exported-session.html", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("HTML export completed")

			const html = readFileSync(htmlPath, "utf-8")
			const match = html.match(/<script id="session-data" type="application\/json">([\s\S]*?)<\/script>/)
			if (!match?.[1]) throw new Error("session-data script not found in HTML export")
			const payload = JSON.parse(Buffer.from(match[1], "base64").toString("utf-8")) as {
				systemPrompt?: string
			}
			expect(payload.systemPrompt).toContain("You are Kimchi, an AI coding agent by CAST AI")
			expect(payload.systemPrompt).not.toContain("operating inside pi, a coding agent harness")
			trace.step("HTML payload carries the harness prompt")
		},
	)
})
