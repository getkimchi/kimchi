/**
 * E2E TUI test: an approved plan never dead-ends under org-policy mode
 * restrictions.
 *
 * Plan-only policy: the review menu hides the execution options up front
 * (nothing can run — the policy allows no executable mode) instead of
 * failing after the click, and explains why.
 *
 * Plan+default policy: approval releases plan mode into default — the
 * highest mode the policy leaves where work can run behind per-tool
 * approvals — and execution proceeds. Previously this refused because only
 * auto/yolo were valid release targets.
 */

import { expect, Key, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { FERMENT_LEGACY_ENV, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PLAN = "# Cache migration\n\n- Preserve the public API.\n- Verify rollback before deployment."

test("plan-only policy hides execution options in the plan review menu", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-plan-approval-plan-only",
			// Legacy Ferment on, so its absent "Start as ferment" option is the policy's doing.
			env: FERMENT_LEGACY_ENV,
			extraArgs: ["--plan=true"],
			policy: { modes: { plan: true, default: false, auto: false, yolo: false } },
			responses: [
				{
					stream: [],
					toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan: PLAN }) } }],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Plan a cache migration and wait for approval.")
			// The plan-only policy surfaces persistently from session start: the
			// status line warns that execution isn't available before any submit.
			await waitForText(terminal, "plan-only", { full: false })
			const started = viewText(terminal)
			expect(started).toContain("Org policy is plan-only")
			trace.step("plan-only status warning visible at session start")

			await waitForText(terminal, "Rework the plan", { full: false })
			const review = viewText(terminal)
			// The menu explains the policy up front and offers no dead-end options.
			// Assert the notice's width-proof prefix — the full sentence embeds the
			// variable-length plan path and clips on narrow terminals.
			expect(review).toContain("Plan saved to")
			expect(review).not.toContain("Execute the plan")
			expect(review).not.toContain("Start as ferment")
			trace.step("plan-only menu offers only Rework, with the policy explanation")

			terminal.keyPress(Key.Enter)
			await waitForText(terminal, PROMPT_READY, { full: false })
			await waitForText(terminal, "plan → shift+tab", { full: false })
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			).toHaveLength(1)
			trace.step("rework closes the review, stays in plan mode, no execution turn dispatched")
		},
	)
})

test("plan+default policy releases an approved plan into default mode", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-plan-approval-default-release",
			extraArgs: ["--plan=true"],
			policy: { modes: { plan: true, default: true, auto: false, yolo: false } },
			responses: [
				{
					stream: [],
					toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan: PLAN }) } }],
				},
				// Ferment is on by default, so Execute starts a plan execution run;
				// blocking it ends the run after the execution turn.
				{
					stream: ["APPROVED_PLAN_EXECUTION_STARTED"],
					toolCalls: [
						{
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "blocked", reason: "Waiting for review." }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Plan a cache migration and wait for approval.")
			await waitForText(terminal, "Execute the plan", { full: false })
			trace.step("review menu offers local execution")
			terminal.keyPress(Key.Enter)
			// The plan execution footer segment can crowd out the shift+tab hint,
			// so match the mode with or without it.
			await waitForText(terminal, "Plan execution started.", { full: false })
			await waitForText(terminal, /default(?: → shift\+tab)? · basic\b/, { full: false })
			trace.step("approved plan released plan mode into default")
			await waitForText(terminal, "APPROVED_PLAN_EXECUTION_STARTED")
			await waitForText(terminal, "Plan execution blocked.")
			expect(fullText(terminal)).toContain("Preserve the public API.")
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			).toHaveLength(2)
			trace.step("execution turn ran with the approved plan in context")
		},
	)
})
