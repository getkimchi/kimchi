/**
 * E2E TUI test: stage-boundary auto-compaction actually shrinks the wire context.
 *
 * Regression for run 019ffb83 (and session 01a00027): the pi-agent-core run loop
 * snapshots messages at run start, so a mid-run inline compact() that suppresses
 * upstream's abort replaced `agent.state.messages` where the live loop never
 * looked — the compaction "fired" but the next LLM request still carried the full
 * pre-compaction transcript.
 *
 * This test drives a ferment through complete_ferment_step with enough fake
 * usage to pass the step gates, lets the turn_end drain summarize the session
 * (the fake model returns a unique summary marker), then asserts on the NEXT
 * request recorded by the fake server: it must contain the summary marker and
 * must NOT contain a unique pre-compaction filler blob. Without the
 * emitContext resync, the request would carry the filler and not the marker.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const SUMMARY_MARKER = "C0MPACT_SUMMARY_MARKER_x7"
const FILLER_TOKEN = "BL0B_UN1QUE_FILLER"
// Byte inflation so upstream's prepare step sees a genuinely compact-able
// session (its token estimate is byte-based). NOTE: the assertion needs only a
// unique pre-compaction marker, not bulk — the gates to cross are usage-based
// (script #6 reports 200k tokens). The tracer is deliberately kept small:
// during diagnosis a 30_000-repeat (~540KB) blob froze the packaged binary's
// event loop for >50s inside the interactive session (heartbeat timers and
// status polls stopped; the same stack completes mid-run inline compaction in
// ~1.5s in-process under vitest). That binary-only size-dependent stall is a
// renderer/tokenizer-class issue worth its own investigation, tracked via this
// comment; it is orthogonal to the compaction mechanism this test asserts.
const FILLER_TEXT = `${FILLER_TOKEN} `.repeat(3_000)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Wire Shrink Marker Flow",
	goal: "Produce a step completion that crosses the stage compaction gates.",
	success_criteria: ["One phase with one step completes"],
	constraints: ["none"],
	assumptions: "The compaction pipeline runs between the step completion and the next turn.",
	phases: [
		{
			name: "Compaction phase",
			goal: "Complete a gate-only step while the context estimate is large.",
			// Two steps: completing a NON-TERMINAL step records the pending step
			// compaction. A terminal (last-in-phase) step defers to the phase
			// boundary by design (see maybeRecordStepCompaction's skip guard).
			steps: [
				{
					description: "Emit a large blob and complete the step.",
				},
				{
					description: "Remainder step, never exercised by this test.",
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

const STEP_GATES = JSON.stringify([
	{ id: "S1", verdict: "pass", rationale: "Summary matches the turn work", evidence: "marker emitted" },
	{ id: "S2", verdict: "omitted", rationale: "No verify command on this step", evidence: "n/a" },
	{ id: "S3", verdict: "pass", rationale: "No edge cases; marker flow only", evidence: "n/a" },
])

test("stage compaction makes the next request carry the summary instead of the old transcript", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-stage-compaction-wire-shrink",
			gitInit: true,
			// Large context window: keeps the mid-turn threshold (window − 16,384
			// = 245,760) above the fake usage (200k) so only the stage drain fires,
			// while the 60% step gate (157,286) and 50k min gate both pass.
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [
				// Turn 1: propose scoping (same entry flow as ferment-new-runs-planning).
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
				// Turn 2 (post-confirmation keepalive nudge).
				{},
				// Turn 3 (host nudge): activate the phase.
				{
					stream: ["Activating the phase."],
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
				// Turn 5 (auto-continuation after activate's tool result): start the step.
				{
					stream: ["Starting the step."],
					toolCalls: [
						{
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
					usage: { prompt_tokens: 5_000, completion_tokens: 200 },
				},
				// Turn 6 (auto-continuation after start's tool result): emit the
				// filler blob and complete the step with usage far above the
				// min/step compaction gates. This is the last turn BEFORE the
				// turn_end stage drain fires.
				{
					stream: [FILLER_TEXT],
					toolCalls: [
						{
							function: {
								name: "complete_ferment_step",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									phase_id: "phase-1",
									step_id: "step-1",
									summary: "Emitted the filler blob for the compaction assertion.",
									gates: JSON.parse(STEP_GATES),
								}),
							},
						},
					],
					usage: { prompt_tokens: 200_000, completion_tokens: 1_000 },
				},
				// Turn 7 is the COMPACTION SUMMARIZATION call itself (fired by the
				// turn_end drain between turns). Its streamed text is stored as
				// the compaction summary in the session.
				{
					stream: [`${SUMMARY_MARKER}: prior turns produced the filler blob; step 1/1 completed with passing gates.`],
					usage: { prompt_tokens: 210_000, completion_tokens: 300 },
				},
				// Turn 8: the auto-compaction continuation turn. With the
				// emitContext resync this request's body carries the compacted
				// context (summary marker) instead of the stale full transcript.
				{
					stream: ["Compaction ack — proceeding with the next action."],
					usage: { prompt_tokens: 40_000, completion_tokens: 100 },
				},
				// Keepalive for any reactive nudge afterwards.
				{},
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
			terminal.submit("Drive the compaction assertion flow")
			trace.step("submitted intent")

			// Stage 4: plan-review dialog → confirm "Start execution".
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 5: the post-compaction continuation text appears. Its arrival
			// means turn 8's request is recorded on the fake server.
			await waitForText(terminal, "Compaction ack", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("post-compaction continuation turn visible")

			// Assert on the recorded chat-completion bodies.
			const chatRequests = fixture.fake.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length).toBeGreaterThanOrEqual(3)
			const bodies = chatRequests.map((req) => JSON.stringify(req.body))

			// Sanity: the filler blob really was on the wire before compaction.
			const sawFiller = bodies.some((body) => body.includes(FILLER_TOKEN))
			expect(sawFiller).toBe(true)
			trace.step("pre-compaction request carried the filler blob (sanity)")

			// The final request is the auto-compaction continuation turn. With the
			// inline-compact resync it carries the summary marker, not the filler.
			// Without the resync (the 019ffb83 regression) it would be inverted:
			// the run loop's run-start snapshot still holds the full transcript.

			const lastBody = bodies[bodies.length - 1]
			expect(lastBody).toContain(SUMMARY_MARKER)
			expect(lastBody).not.toContain(FILLER_TOKEN)
			trace.step("post-compaction request carries summary marker and not the filler blob")
		},
	)
})
