/**
 * E2E TUI test: plannotator plan-review approval — where-dialog race.
 *
 * Regression coverage (deterministic; mocked unit tests cannot see this):
 * When plannotator approves an adhoc plan review, the
 * `kimchi:plan-review-decision` listeners fire in registration order:
 *   1. the persistent decision handler (opens the "Plan approved — where
 *      should it run?" dialog when remote run is enabled),
 *   2. the per-review abort listener (dismisses the legacy TUI review menu).
 * pi's TUI keeps a SINGLE extensionSelector and disposes whatever is current
 * on abort — without the one-macrotask defer in the where-dialog sites, OUR
 * dialog gets destroyed by the same emit and its promise never resolves,
 * hanging the handler. The user sees the review menu vanish and nothing
 * opens; execution can never start.
 *
 * Uses the KIMCHI_E2E_FAKE_PLANNOTATOR_DECISION seam (test-only) to emit the
 * fake plannotator decision 1s after submit_plan — while the legacy TUI menu
 * is open — reproducing the listener-order race exactly. Signals:
 *   - the where-dialog must become visible AND answerable,
 *   - the legacy menu ("Plan complete. How would you like to proceed?")
 *     must not block: selecting "Execute the plan locally" proceeds,
 *   - execution actually starts (auto mode + execution turn + plan file).
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PLAN_TEXT =
	"Here's a lightweight plan:\n\n" +
	"1. Read the relevant source files\n" +
	"2. Make the targeted change\n" +
	"3. Run tests to verify\n"

test("plannotator approval opens answerable where-dialog while legacy menu dismisses", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-plannotator",
			gitInit: true,
			// Opt back into remote run (the fixture pins KIMCHI_REMOTE_RUN=0) so
			// the where-dialog route is taken, and fire the fake plannotator
			// "execute" decision 1s after the plan review request.
			env: { KIMCHI_REMOTE_RUN: "1", KIMCHI_E2E_FAKE_PLANNOTATOR_DECISION: "execute" },
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [
				// Turn 1: model streams the plan and calls submit_plan → review
				// surfaces open; the seam then fires the plannotator decision.
				{
					stream: [PLAN_TEXT],
					toolCalls: [
						{
							id: "call_submit_plan",
							type: "function",
							function: {
								name: "submit_plan",
								arguments: JSON.stringify({ plan: PLAN_TEXT }),
							},
						},
					],
				},
				// Turn 2: execution turn after "Execute the plan locally".
				{ stream: ["Plan executed. Ready for the next task.\n"] },
			],
			extraArgs: ["--plan=true"],
		},
		async (fixture, trace) => {
			// Stage 1: session ready. (Status-line mode segments vary with remote
			// run enabled, so the legacy menu below is the plan-mode proof.)
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("session ready")

			// Stage 2: submit request → model streams the plan + submit_plan, the
			// legacy TUI review menu opens (remote run enabled → remote option).
			// submit_plan is only registered in plan mode (--plan=true) — the menu
			// appearing proves plan mode is active.
			terminal.submit("Plan out how to add a new feature.")
			await waitForText(terminal, "Plan complete. How would you like to proceed?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("legacy plan-review menu visible")

			// Stage 3: the seam fires the plannotator approval ~1s later. The
			// where-dialog must appear. WITHOUT the one-macrotask defer it gets
			// disposed by the same emit's later abort listener and this wait
			// times out — that timeout IS the regression signal.
			await waitForText(terminal, "Plan approved — where should it run?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Execute the plan locally", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Execute the plan in a remote workspace", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("where-dialog visible with both options")

			// Stage 4: the dialog must be answerable — the legacy menu must NOT
			// be the selector currently holding input. Select the first option,
			// "Execute the plan locally".
			terminal.keyPress(Key.Enter)
			trace.step("selected 'Execute the plan locally'")

			// Stage 5: the session proceeds — approval transitions to auto mode
			// and the execution turn runs. If the legacy menu still held the
			// selector, Enter would have picked ITS option instead and the
			// where-dialog handler would still be hung; reaching auto here
			// proves the legacy menu was dismissed and our dialog resolved.
			await waitForText(terminal, "Plan executed. Ready for the next task.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("execution started in auto mode after local selection")

			// Stage 6: the approved plan file was written by submit_plan.
			const plansDir = join(fixture.workDir, ".kimchi", "plans")
			expect(existsSync(plansDir)).toBe(true)
			expect(readdirSync(plansDir).filter((f) => f.endsWith(".md")).length > 0).toBe(true)
			trace.step("approved plan file written")
		},
	)
})
