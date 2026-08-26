import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PACKAGE_DIR, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const WORKFLOW_SOURCE = resolve(PACKAGE_DIR, "../../..", ".kimchi/workflows/loop-review.workflow.ts")

test("loop-review confirms inferred branch intent before starting reviewers", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "loop-review-intent-gate",
			gitInit: true,
			models: [
				{ slug: "basic", displayName: "Fake Basic", provider: "ai-enabler" },
				{ slug: "glm-5.2-fp8", displayName: "GLM 5.2 FP8", provider: "ai-enabler" },
				{ slug: "kimi-k2.7", displayName: "Kimi K2.7", provider: "ai-enabler" },
			],
			responses: [
				{
					stream: ["I reconstructed the branch intent."],
					toolCalls: [
						{
							function: {
								name: "workflow_submit_questions",
								arguments: JSON.stringify({
									title: "Confirm change intent",
									questions: [
										{
											key: "intentDecision",
											header: "Intent",
											question:
												"The branch adds a repository-bundled review loop that confirms intent before reviewing.",
											kind: "single",
											options: [
												{
													value: "confirm",
													label: "Confirm and start review",
													recommended: true,
												},
												{ value: "revise", label: "Needs correction" },
											],
										},
									],
								}),
							},
						},
					],
				},
			],
			seedHome: (homeDir, workDir) => {
				const workflowsDir = join(workDir, ".kimchi", "workflows")
				mkdirSync(workflowsDir, { recursive: true })
				copyFileSync(WORKFLOW_SOURCE, join(workflowsDir, "loop-review.workflow.ts"))

				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const settingsPath = join(agentDir, "settings.json")
				const settings: Record<string, unknown> = JSON.parse(readFileSync(settingsPath, "utf8"))
				settings.resources = { "extensions.workflows": true }
				writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"), "utf8")
			},
		},
		async (fixture, trace) => {
			terminal.submit("/workflow run loop-review")
			trace.step("started loop-review")

			await waitForText(
				terminal,
				"The branch adds a repository-bundled review loop that confirms intent before reviewing.",
				{ timeoutMs: STREAM_TIMEOUT_MS },
			)
			await waitForText(terminal, "Confirm and start review")
			await waitForText(terminal, "Needs correction")
			trace.step("intent confirmation is visible before review")

			const agentRequests = fixture.fake.requests.filter((request) =>
				request.url.startsWith("/openai/v1/chat/completions"),
			)
			expect(agentRequests).toHaveLength(1)
			expect(JSON.stringify(agentRequests[0]?.body)).not.toContain("<inherited_system_prompt>")
			trace.step("only the intent agent has run")
		},
	)
})
