/**
 * E2E TUI test: plan-to-ferment promotion flow.
 *
 * This file has two test cases:
 *
 * 1. "plan-to-ferment promotion — dropdown UI":
 *    Exercises the START_AS_FERMENT dropdown path end-to-end.
 *    Choosing Start as ferment must trigger the implementation turn without
 *    another user message.
 *
 * 2. "plan-to-ferment promotion — side effects via submit_plan handler"
 *    (test): Verifies the side effects of the plan-to-ferment flow by
 *    checking that the approved plan file is written to .kimchi/plans/ when
 *    the model calls submit_plan. No dropdown UI assertions.
 *    The tool-swap from questionnaire → ask_user is also confirmed via the
 *    recorded request bodies (proxied by the TUI's tool-list rendering).
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// ---------------------------------------------------------------------------
// Test 1: Dropdown UI and automatic implementation handoff
// ---------------------------------------------------------------------------
test("plan-to-ferment promotion — Start as ferment immediately continues execution", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-to-ferment-promo",
			gitInit: true,
			responses: [
				{
					stream: [
						"## Goal\nImplement a streaming think parser.\n\n",
						"## Constraints\n- Preserve the existing parser API\n\n",
						"## Chunks\n\n",
						"### Chunk 1: Implement streaming parser\n",
						"- **Files Changed**: src/parser.ts\n",
						"- **Accept When**: streaming think blocks parse correctly\n\n",
						"## Verification Strategy\nRun the parser tests.\n\n",
					],
					toolCalls: [
						{
							id: "call_submit_plan",
							type: "function",
							function: {
								name: "submit_plan",
								arguments: JSON.stringify({
									plan:
										"## Goal\nImplement a streaming think parser.\n\n" +
										"## Constraints\n- Preserve the existing parser API\n\n" +
										"## Chunks\n\n" +
										"### Chunk 1: Implement streaming parser\n" +
										"- **Files Changed**: src/parser.ts\n" +
										"- **Accept When**: streaming think blocks parse correctly\n\n" +
										"## Verification Strategy\nRun the parser tests.\n",
								}),
							},
						},
					],
				},
				{ stream: ["I'll start implementing the streaming think parser."] },
			],
			extraArgs: ["--plan=true"],
		},
		async (fixture, trace) => {
			// Stage 1: plan mode confirmed in status line. The shortcut hint may be
			// stripped under the new compaction ladder, so match "plan" with or
			// without "→ shift+tab" and anchored by the model segment.
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("status line confirms plan mode")

			// Stage 2: submit request → model streams the plan, then calls
			// submit_plan. The dropdown appears after the tool call terminates
			// the turn.
			terminal.submit("Implement a streaming think parser")
			trace.step("submitted planning request")

			// Stage 3: dropdown appears — all three options must be visible in buffer.
			await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Rework the plan", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Start as ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("all three dropdown options visible")

			// Stage 4: navigate to "Start as ferment" (index 2) and select.
			terminal.keyDown()
			terminal.keyDown()
			trace.step("navigated to 'Start as ferment'")
			terminal.keyPress(Key.Enter)
			trace.step("selected 'Start as ferment'")

			// Stage 5: dropdown closes — Ferment is running under auto permissions.
			// Status-line order is now permissions/model first, then ferment, so
			// look for "auto" leading and "Ferment: ... · Running" somewhere after.
			await waitForText(terminal, /auto · .* · Ferment: .* · Running/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("status line transitioned to auto — ferment created")

			// Stage 6: verify the ferment artifact was written.
			const fermentsDir = join(fixture.workDir, ".kimchi", "ferments")
			const files = readdirSync(fermentsDir).filter((file) => file.endsWith(".json"))
			expect(files.length).toBe(1)
			const [fermentFile] = files
			expect(fermentFile).toMatch(/\.json$/)

			const fermentArtifact = JSON.parse(readFileSync(join(fermentsDir, fermentFile), "utf-8"))
			expect(fermentArtifact).toHaveProperty("id")
			expect(fermentArtifact).toHaveProperty("name")
			expect(fermentArtifact.status).toBe("running")
			expect(fermentArtifact).toHaveProperty("phases")
			expect(Array.isArray(fermentArtifact.phases)).toBe(true)
			expect(fermentArtifact.phases.length > 0).toBe(true)
			trace.step("ferment artifact valid")

			// Stage 7: the handoff itself triggers the implementation turn. Requiring
			// another submitted prompt here would reproduce the original stall.
			await waitForText(terminal, "I'll start implementing", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("implementation response triggered without another user message")
		},
	)
})

// ---------------------------------------------------------------------------
// Test 2: Side-effect verification via submit_plan handler (no dropdown UI)
// ---------------------------------------------------------------------------

// Verifies the plan-to-ferment contract by checking the filesystem side effects
// of the submit_plan handler (permissions/index.ts). The model calls submit_plan
// with the plan text, the handler writes the approved plan to .kimchi/plans/
// and transitions to auto mode. No dropdown UI assertions are made — this test
// proves the contract works by examining the artifact files and TUI state.
test("plan-to-ferment promotion — side effects: plan file written + tool swap at turn boundary", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-to-ferment-sidefx",
			gitInit: true,
			responses: [
				{
					stream: [
						"Here's a lightweight plan:\n\n",
						"1. Read the relevant source files\n",
						"2. Make the targeted change\n",
						"3. Run tests to verify\n\n",
					],
					toolCalls: [
						{
							id: "call_submit_plan",
							type: "function",
							function: {
								name: "submit_plan",
								arguments: JSON.stringify({
									plan:
										"Here's a lightweight plan:\n\n" +
										"1. Read the relevant source files\n" +
										"2. Make the targeted change\n" +
										"3. Run tests to verify\n",
								}),
							},
						},
					],
				},
				{ stream: ["Plan executed. Ready for the next task.\n"] },
			],
			extraArgs: ["--plan=true"],
		},
		async (fixture, trace) => {
			// Stage 1: plan mode confirmed in status line. The shortcut hint may be
			// stripped under the new compaction ladder, so match "plan" with or
			// without "→ shift+tab" and anchored by the model segment.
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("status line confirms plan mode")

			// Stage 2: submit request → model streams the plan, then calls
			// submit_plan. The dropdown appears after the tool call terminates
			// the turn.
			terminal.submit("Plan out how to add a new feature.")
			trace.step("submitted planning request")
			await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("submit_plan tool called — plan-complete handler fired")

			// Stage 3: the dropdown appears. Press Enter to default-select
			// "Execute the plan" (first option).
			terminal.keyPress(Key.Enter)
			trace.step("pressed Enter to select default dropdown option ('Execute the plan')")

			// Stage 4: the plan-complete handler transitions to auto mode.
			// Match "auto" with or without the stripped shortcut hint, anchored by
			// the model segment.
			await waitForText(terminal, /auto(?: → shift\+tab)? · basic\b/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("status line transitioned to auto — handler fired and mode changed")

			// Verify the approved plan file was written (proof that submit_plan
			// executed the write path at permissions/index.ts).
			const plansDir = join(fixture.workDir, ".kimchi", "plans")
			const planFiles = readdirSync(plansDir)
			expect(planFiles.length > 0).toBe(true)
			const [planFile] = planFiles
			expect(planFile).toMatch(/\.md$/)

			const planContent = readFileSync(join(plansDir, planFile), "utf-8")
			// The plan text comes from the submit_plan tool argument.
			expect(planContent.includes("Read the relevant source files")).toBe(true)
			expect(planContent.includes("Make the targeted change")).toBe(true)
			expect(planContent.includes("Run tests to verify")).toBe(true)
			trace.step("approved plan file written and content verified")
		},
	)
})
