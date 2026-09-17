import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const [action, key] of [
	["dismissing", Key.Escape],
	["answering", Key.Enter],
] as const) {
	test(`${action} the survey preserves the pending plan approval`, async ({ terminal }) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `plan-review-survey-${action}`,
				gitInit: true,
				extraArgs: ["--plan=true"],
				seedHome(homeDir) {
					const configPath = join(homeDir, ".config", "kimchi", "config.json")
					const config = JSON.parse(readFileSync(configPath, "utf-8"))
					config.surveys = {}
					writeFileSync(configPath, JSON.stringify(config), "utf-8")
				},
				responses: [
					{ stream: ["First requirement noted."] },
					{ stream: ["Second requirement noted."] },
					{
						toolCalls: [
							{
								function: {
									name: "ExitPlanMode",
									arguments: JSON.stringify({ plan: "## Goal\nCreate example.txt and verify its contents." }),
								},
							},
						],
					},
					{ stream: ["APPROVED_PLAN_EXECUTION_STARTED"] },
				],
			},
			async (fixture, trace) => {
				terminal.submit("The plan should create example.txt.")
				await waitForText(terminal, "First requirement noted.")
				await waitForTurnToSettle(fixture.fake.requests)
				terminal.submit("Verify the file contents too.")
				await waitForText(terminal, "Second requirement noted.")
				await waitForTurnToSettle(fixture.fake.requests)
				trace.step("two coding prompts completed without a survey")

				terminal.submit("Submit the completed plan.")
				await waitForText(terminal, "How did Kimchi do?", { full: false })
				trace.step("third-prompt survey appeared while plan approval was pending")
				terminal.keyPress(key)
				await expect(terminal.getByText("How did Kimchi do?")).not.toBeVisible({ timeout: INPUT_TIMEOUT_MS })
				await waitForText(terminal, "Execute the plan", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
				trace.step("closing the survey restored the plan approval")

				terminal.keyPress(Key.Enter)
				await waitForText(terminal, "APPROVED_PLAN_EXECUTION_STARTED")
				trace.step("plan approval consumed Enter and started execution")
			},
		)
	})
}
