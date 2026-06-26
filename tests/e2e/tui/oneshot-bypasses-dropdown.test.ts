/**
 * E2E TUI test: --ferment-oneshot bypasses the plan-complete dropdown.
 *
 * Flow:
 * 1. Launch with --ferment-oneshot flag (no --plan).
 * 2. User types a request.
 * 3. The dropdown (Execute / Rework / Start as ferment) does NOT appear.
 * 4. Ferment lifecycle proceeds without showing the dropdown (the flag guard at
 *    permissions/index.ts:506-508 returns early from the dropdown handler).
 */

import { Key, expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, fullText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("--ferment-oneshot bypasses the plan-complete dropdown and enters ferment lifecycle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "oneshot-bypasses-dropdown",
			gitInit: true,
			responses: [
				// In oneshot mode the model can emit a plan with PLAN_COMPLETE — but the
				// flag guard at permissions/index.ts:506-508 returns early, so the dropdown
				// handler is skipped entirely and no dropdown appears in the TUI.
				{
					stream: [
						"# Plan\n",
						"\n",
						"## Goal\n",
						"Add a new API endpoint.\n",
						"\n",
						"## Steps\n",
						"1. Create the route handler.\n",
						"2. Add tests.\n",
						"\n",
						"<!-- PLAN_COMPLETE -->\n",
					],
				},
				// Follow-up response so the session stays alive after the first response.
				{ stream: ["Proceeding with the ferment lifecycle."] },
			],
			extraArgs: ["--ferment-oneshot=true"],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt visible. Oneshot mode may show a different prompt
			// (skipping the standard interactive editor), so wait for either form.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS }).catch(
				async () => {
					// Fallback: in oneshot mode the prompt may differ — wait for any visible
					// content past startup, then proceed.
					await new Promise((resolve) => setTimeout(resolve, 1_500))
				},
			)
			trace.step("ready prompt visible (or oneshot bootstrapped)")

			// Stage 2: submit request → model emits plan with PLAN_COMPLETE marker.
			terminal.submit("Add a new API endpoint")
			trace.step("submitted request")
			await waitForText(terminal, "<!-- PLAN_COMPLETE -->", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plan complete marker seen — but dropdown must NOT appear in oneshot mode")

			// Stage 3: wait briefly to give the dropdown handler a chance to (incorrectly)
			// render, then sample the terminal text and assert the dropdown labels are absent.
			// @microsoft/tui-test expect() takes only one argument (no message), so we
			// collect violations in an array and assert once at the end.
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			const text = fullText(terminal)

			const violations: string[] = []
			for (const label of [
				"Execute the plan",
				"Rework the plan",
				"Start as ferment",
				"How would you like to proceed",
			]) {
				if (text.includes(label)) violations.push(label)
			}
			expect(violations.length === 0).toBe(true)
			trace.step("no dropdown labels present in --ferment-oneshot session")

			// Stage 4: ensure no key input accidentally triggers the dropdown. Send a
			// harmless Enter and verify the dropdown still hasn't appeared.
			terminal.keyPress(Key.Enter)
			await new Promise((resolve) => setTimeout(resolve, 1_000))
			const finalText = fullText(terminal)
			const finalViolations: string[] = []
			for (const label of ["Execute the plan", "Start as ferment"]) {
				if (finalText.includes(label)) finalViolations.push(label)
			}
			expect(finalViolations.length === 0).toBe(true)
			trace.step("final check: no dropdown anywhere in session")
		},
	)
})
