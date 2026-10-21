/**
 * E2E TUI test: per-scope staleness during a ferment step.
 *
 * Spec (fix-stale-todos.md, Chunk 3): an unfinished global list alongside
 * step work and step writes still produces scope-labelled global pressure.
 * The unit suite covers the tracker in isolation; this test proves the
 * wiring in a real session — the auto-scope provider engaging, the bridge
 * seeding the step list, and the reminder steer reaching the model.
 *
 * Scenario: a step runs with a reconciled, fully-completed step list while
 * a global list with unfinished items is never written. Ten work calls
 * produce the first global reminder; a mid-flight step-list write (which
 * resets only the step epoch) must NOT silence it, so the next ten calls
 * produce the "20 changes" reminder. If scope resolution collapsed both
 * lists into one epoch, the second decade would re-fire "10 changes" and
 * the "20 changes" assertion would fail.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Scope Staleness Pressure Flow",
	goal: "Run a step while a global list ages with scope-labelled pressure.",
	success_criteria: ["Global staleness reminders are scope-labelled"],
	constraints: ["none"],
	assumptions: "The step list stays completed and reconciled throughout.",
	phases: [
		{
			name: "Pressure phase",
			goal: "Run one step without completing it during the test window.",
			steps: [
				{
					description: "Do work in the step scope while the global list ages.",
				},
			],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Single step", evidence: "n/a" },
		{ id: "P2", verdict: "omitted", rationale: "Single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "Gates suffice", evidence: "n/a" },
	],
})

/** One bash work call — a separate response per call, matching how the
 *  harness delivers tool calls (one per response). */
const workCall = (round: number, index: number): FakeResponseScript => ({
	toolCalls: [
		{
			id: `call-work-${round}-${index}`,
			function: {
				name: "bash",
				arguments: JSON.stringify({ command: `printf 'round ${round} work ${index} done\\n'` }),
			},
		},
	],
})

const workRound = (round: number, count: number): FakeResponseScript[] =>
	Array.from({ length: count }, (_, index) => workCall(round, index))

test("per-scope staleness: step work and step writes keep global-list pressure alive", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todos-scope-staleness",
			gitInit: true,
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 }],
			responses: [
				// Turn 1: propose scoping (same entry flow as the other
				// interactive ferment tests).
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							id: "call-propose-1",
							function: { name: "propose_ferment_scoping", arguments: PROPOSE_SCOPING_PAYLOAD },
						},
					],
				},
				// Turn 2 (post-confirmation keepalive nudge).
				{},
				// Turn 3 (host nudge): activate the phase.
				{
					stream: ["Activating the phase."],
					toolCalls: [
						{
							id: "call-activate-1",
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
				// Turn 4 (auto-continuation): start the step. The bridge seeds
				// the step scope with its in_progress title anchor.
				{
					stream: ["Starting the step."],
					toolCalls: [
						{
							id: "call-start-1",
							function: {
								name: "start_ferment_step",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									phase_id: "phase-1",
									step_id: "step-1",
									budget_tier: "standard",
								}),
							},
						},
					],
				},
				// Turn 5: reconcile the bridge-seeded step list (the check-in
				// gate requires it before further work tools) — the anchor
				// becomes completed, so the step list never ages afterwards.
				{
					stream: ["Reconciling the seeded step list first."],
					toolCalls: [
						{
							id: "call-mark-1",
							function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
						},
					],
				},
				// Turn 6: create the global list with unfinished items. The
				// explicit global scope matters — scope-less writes would
				// auto-target the running step. The create reconciles it, so
				// work flows; from here the global list is never written again.
				{
					stream: ["Now creating the global list."],
					toolCalls: [
						{
							id: "call-create-1",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									scope: { kind: "global" },
									todos: [
										{ content: "Ship the feature", status: "pending" },
										{ content: "Write the release notes", status: "pending" },
									],
								}),
							},
						},
					],
				},
				// Turn 7: ten work calls — the first boundary (10) fires a
				// scope-labelled global reminder.
				...workRound(1, 10),
				// Turn 8: a step-list write (scope-less auto-targets the running
				// step). It resets only the step epoch; the global list keeps
				// aging. The list stays fully completed, so the step scope
				// never becomes relevant.
				{
					stream: ["Noting step progress in the step list."],
					toolCalls: [
						{
							id: "call-update-1",
							function: {
								name: "update_todos",
								arguments: JSON.stringify({ todos: [{ content: "Step progress noted", status: "completed" }] }),
							},
						},
					],
				},
				// Turn 9: ten more work calls — the global counter crosses
				// boundary 20. If the turn-8 step write had reset the global
				// epoch, this would re-fire "10 changes" instead.
				...workRound(2, 10),
				// Turn 10: wrap-up text. (The bounded closure check may fire
				// once afterwards — work completed after the last global
				// reconciliation — which is out of scope here.)
				{ stream: ["Both work rounds complete."] },
				// Keepalive for the closure/continuation turn, if any.
				{ stream: ["<done>"] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: enter ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt → submit.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")
			terminal.submit("Drive the per-scope staleness assertion flow")
			trace.step("submitted intent")

			// Stage 4: plan-review dialog → confirm "Start execution".
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 5: the wrap-up text appears — every scripted turn ran.
			await waitForText(terminal, "Both work rounds complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("both work rounds completed")

			const chat = fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			expect(chat.length).toBeGreaterThanOrEqual(10)
			const history = JSON.stringify(chat)

			// The first boundary fired a scope-labelled global reminder.
			expect(history).toContain("10 changes since the global todo list was last updated")
			trace.step("boundary-10 global reminder reached the model")

			// The step write in between did not silence the global list: the
			// second decade crossed boundary 20, not a reset "10 changes".
			expect(history).toContain("20 changes since the global todo list was last updated")
			trace.step("boundary-20 global reminder after the step write — per-scope epochs isolated")

			// The step list stayed completed and reconciled: no step-scope
			// staleness pressure ever fired.
			expect(history).not.toContain("step phase-1/step-1 todo list")
			trace.step("no step-scope reminder — the completed step list never aged")
		},
	)
})
