/**
 * E2E TUI test: the ferment status-line segment reflects state changes driven
 * by tool calls (activate_ferment_phase, start_ferment_step, ...).
 *
 * Regression: `createApplyAndPersist` (the canonical path for all ferment
 * tool-call mutations) updated the in-memory active ferment via
 * `runtime.setActive()` but never requested a status-line re-render. The
 * status line's ferment segment reads `getActive()` at render time, so without
 * an explicit render request it went stale until a keypress or message render
 * happened. The fix calls `requestSharedStatusLineRender()` after every
 * successful mutation.
 *
 * This test starts a ferment, scopes it, and has the model call
 * `activate_ferment_phase`. The status line must show the ferment name + "Running".
 */

import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Status Line Update Test",
	goal: "Verify the status-line ferment segment updates on tool-call mutations.",
	success_criteria: ["Status line shows Running after activate_ferment_phase"],
	constraints: [],
	assumptions: "The status-line segment is pinned.",
	phases: [
		{
			name: "Implementation",
			goal: "Activate the phase.",
			steps: [{ description: "Do the work.", verify: "true" }],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "true" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "tests pass", evidence: "n/a" },
	],
})

test("ferment status-line segment updates after activate_ferment_phase tool call", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-status-line-updates-on-mutation",
			gitInit: true,
			responses: [
				// Turn 1: orientation text then propose_ferment_scoping.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (after tool result): short text, no trailing "?".
				{ stream: ["I've outlined the scope for this test."] },
				// Turn 3 (post-confirmation keepalive): mirrors ferment-new-runs-planning.
				{},
				// Turn 4 (host nudge): activate the implementation phase.
				{
					stream: ["Starting implementation."],
					toolCalls: [
						{
							function: {
								name: "activate_ferment_phase",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									phase_id: "phase-1",
								}),
							},
						},
					],
				},
				// Turn 5 (host nudge): start step 1 — must comply to avoid nudge loop.
				{
					stream: ["Starting step 1."],
					toolCalls: [
						{
							function: {
								name: "start_ferment_step",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									phase_id: "phase-1",
									step_id: "step-1",
								}),
							},
						},
					],
				},
				// Extra text-only responses to absorb continuation nudges.
				{ stream: ["Waiting."] },
				{ stream: ["Waiting."] },
				{ stream: ["Waiting."] },
				{ stream: ["Waiting."] },
				{ stream: ["Waiting."] },
			],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: enter ferment.
			terminal.submit("/ferment")
			trace.step("ran /ferment")

			// Stage 3: intent prompt.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes scoping.
			terminal.submit("Verify status line updates on mutation")
			trace.step("submitted intent")

			// Stage 5: plan-review dialog.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			// Stage 6: confirm.
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: status line must show the ferment name + "Running" status.
			// The ferment segment now renders whenever a ferment is active, even
			// when not pinned (matches the ScriptFooter path). This guards the
			// "doesn't show when there's an active ferment" regression.
			await waitForText(terminal, /Status Line Update Test · Running/, { timeoutMs: 30_000 })
			trace.step("status line shows ferment name + Running status")
		},
	)
})
