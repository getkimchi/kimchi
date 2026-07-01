import { expect, test } from "@microsoft/tui-test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * E2E coverage for the cursor-rules extension.
 *
 * Seeds a project with `.cursor/rules/always.mdc` and `.agents/rules/general.mdc`,
 * launches Kimchi against the fake LLM server, submits one prompt, and asserts
 * the rule bodies appear in the recorded system prompt.
 *
 * This complements the unit tests in src/extensions/cursor-rules/ by proving
 * the extension is registered in cli.ts and actually injects rules into live
 * provider requests.
 */

test("cursor-rules extension injects discovered rules into the system prompt", async ({ terminal }) => {
	const cursorMarker = "CURSOR_RULES_E2E_MARKER_42"
	const agentsMarker = "AGENTS_RULES_E2E_MARKER_99"

	await runKimchiSession(
		terminal,
		{
			artifactName: "cursor-rules-injection",
			responses: [{ stream: ["Hello from cursor rules test."] }],
			seedHome(_homeDir, workDir) {
				const cursorRulesDir = join(workDir, ".cursor", "rules")
				const agentsRulesDir = join(workDir, ".agents", "rules")
				mkdirSync(cursorRulesDir, { recursive: true })
				mkdirSync(agentsRulesDir, { recursive: true })
				writeFileSync(
					join(cursorRulesDir, "always.mdc"),
					`---\ndescription: E2E always-apply rule\nalwaysApply: true\n---\n\nAlways mention ${cursorMarker} in your thinking.`,
					"utf-8",
				)
				writeFileSync(
					join(agentsRulesDir, "general.mdc"),
					`---\ndescription: E2E agents rule\nalwaysApply: true\n---\n\nAlways mention ${agentsMarker} in your thinking.`,
					"utf-8",
				)
			},
		},
		async (fixture, trace) => {
			terminal.submit("say hello")
			trace.step("submitted prompt")

			await expect(terminal.getByText("Hello from cursor rules test.", { full: true })).toBeVisible()
			trace.step("response rendered")

			const chatRequests = fixture.fake.requests.filter((request) =>
				request.url.includes("/chat/completions"),
			)
			expect(chatRequests.length).toBeGreaterThan(0)

			const firstRequestBody = JSON.stringify(chatRequests[0].body ?? "")
			expect(firstRequestBody).toContain(cursorMarker)
			expect(firstRequestBody).toContain(agentsMarker)
		},
	)
})
