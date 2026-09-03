/**
 * E2E TUI test: --ferment-oneshot bypasses the plan-complete dropdown.
 *
 * Flow:
 * 1. Launch with --ferment-oneshot flag (no --plan).
 * 2. User types a request.
 * 3. The dropdown (Execute / Rework / Start as ferment) does NOT appear.
 * 4. Ferment lifecycle proceeds without showing the dropdown (the oneshot
 *    scoping tool scope_ferment scopes directly without emitting a review
 *    request — the plannotator adapter skips oneshot sessions, and the TUI
 *    popup is never triggered).
 */

import { expect, Key, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const SCOPE_FERMENT_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Add API Endpoint",
	goal: "Add a new API endpoint.",
	success_criteria: ["Endpoint responds correctly"],
	phases: [
		{
			name: "Implement",
			goal: "Create the route handler and tests.",
			steps: [
				{ description: "Create the route handler.", verify: "echo done" },
				{ description: "Add tests.", verify: "echo done" },
			],
		},
	],
	assumptions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Steps have verify", evidence: "echo done" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "criterion checked", evidence: "n/a" },
	],
})

test("--ferment-oneshot bypasses the plan-complete dropdown and enters ferment lifecycle", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "oneshot-bypasses-dropdown",
			gitInit: true,
			responses: [
				// In oneshot mode the model calls scope_ferment, which scopes
				// the ferment directly without emitting a review request — no
				// dropdown appears in the TUI.
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
					],
					toolCalls: [
						{
							id: "call_scope_ferment",
							type: "function",
							function: {
								name: "scope_ferment",
								arguments: SCOPE_FERMENT_PAYLOAD,
							},
						},
					],
				},
				// Follow-up response so the session stays alive after scoping.
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

			// Stage 2: submit request → model calls scope_ferment. In oneshot
			// mode the dropdown must NOT appear.
			terminal.submit("Add a new API endpoint")
			trace.step("submitted request")
			await waitForText(terminal, "Proceeding with the ferment lifecycle", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("scope_ferment called — dropdown must NOT appear in oneshot mode")

			// Stage 3: wait briefly to give any dropdown handler a chance to
			// (incorrectly) render, then assert the dropdown labels are absent.
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			const text = fullText(terminal)

			const violations: string[] = []
			for (const label of [
				"Execute the plan",
				"Rework the plan",
				"Start as ferment",
				"How would you like to proceed",
				"Proceed with this plan?",
			]) {
				if (text.includes(label)) violations.push(label)
			}
			expect(violations.length === 0).toBe(true)
			trace.step("no dropdown labels present in --ferment-oneshot session")

			// Stage 4: ensure no key input accidentally triggers the dropdown.
			terminal.keyPress(Key.Enter)
			await new Promise((resolve) => setTimeout(resolve, 1_000))
			const finalText = fullText(terminal)
			const finalViolations: string[] = []
			for (const label of ["Execute the plan", "Start as ferment", "Proceed with this plan?"]) {
				if (finalText.includes(label)) finalViolations.push(label)
			}
			expect(finalViolations.length === 0).toBe(true)
			trace.step("final check: no dropdown anywhere in session")
		},
	)
})
