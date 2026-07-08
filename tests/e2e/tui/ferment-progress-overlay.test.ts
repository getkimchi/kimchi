/**
 * E2E TUI tests for the `/ferment progress` overlay.
 *
 * Covers two user-visible behaviors:
 * 1. The overlay opens and shows the ferment name, progress bar, phase list,
 *    and the "now:" line.
 * 2. The overlay shows 1/2 steps done after a complete step lifecycle
 *    (start → complete), verifying the overlay reads fresh state.
 *
 * The response scripts follow the host's continuation nudge sequence: after
 * each tool call, the host nudges the model to call the next action. The fake
 * model must comply with each nudge (activate → start_step → complete_step →
 * start_step) so the agent eventually goes idle and the prompt returns.
 * Extra text-only responses absorb any remaining continuation nudges.
 */

import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Progress Overlay Test",
	goal: "Verify the /ferment progress overlay shows live state.",
	success_criteria: ["Overlay shows phase list and progress bar"],
	constraints: [],
	assumptions: "The overlay renders correctly.",
	phases: [
		{
			name: "Implementation",
			goal: "Implement and verify the feature.",
			steps: [
				{ description: "Write the code", verify: "true" },
				{ description: "Run the tests", verify: "true" },
			],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "true" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "tests pass", evidence: "n/a" },
	],
})

// Shared response turns for the tool-call sequence after plan confirmation.
const ACTIVATE_PHASE = {
	stream: ["Starting implementation."],
	toolCalls: [
		{ function: { name: "activate_ferment_phase", arguments: JSON.stringify({ ferment_id: "__FERMENT_ID__", phase_id: "phase-1" }) } },
	],
}
const START_STEP_1 = {
	stream: ["Starting step 1."],
	toolCalls: [
		{ function: { name: "start_ferment_step", arguments: JSON.stringify({ ferment_id: "__FERMENT_ID__", phase_id: "phase-1", step_id: "step-1" }) } },
	],
}
const COMPLETE_STEP_1 = {
	stream: ["Step 1 done."],
	toolCalls: [
		{ function: { name: "complete_ferment_step", arguments: JSON.stringify({
			ferment_id: "__FERMENT_ID__", phase_id: "phase-1", step_id: "step-1", summary: "Code written.",
			gates: [
				{ id: "S1", verdict: "pass", rationale: "Summary matches", evidence: "n/a" },
				{ id: "S2", verdict: "pass", rationale: "Verify is real", evidence: "n/a" },
				{ id: "S3", verdict: "pass", rationale: "Edge cases handled", evidence: "n/a" },
			],
		}) } },
	],
}
const START_STEP_2 = {
	stream: ["Starting step 2."],
	toolCalls: [
		{ function: { name: "start_ferment_step", arguments: JSON.stringify({ ferment_id: "__FERMENT_ID__", phase_id: "phase-1", step_id: "step-2" }) } },
	],
}

// Extra text-only responses to absorb continuation nudges after the last
// tool call. The host keeps nudging while the ferment is running; these
// responses let the reactive continuation nudge counter exhaust so the
// agent eventually goes idle and the prompt returns.
const WAITING = Array.from({ length: 10 }, () => ({ stream: ["Waiting."] }))

test("/ferment progress overlay shows ferment name, progress bar, and phase list", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-progress-overlay-basics",
			gitInit: true,
			responses: [
				{ stream: ["I'll outline the scope."], toolCalls: [{ function: { name: "propose_ferment_scoping", arguments: PROPOSE_SCOPING_PAYLOAD } }] },
				{ stream: ["I've outlined the scope."] },
				{},
				ACTIVATE_PHASE,
				START_STEP_1,
				COMPLETE_STEP_1,
				START_STEP_2,
				...WAITING,
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			terminal.submit("Verify progress overlay")
			trace.step("submitted intent")

			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			await waitForText(terminal, "Tip: Open Ferment progress", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("agent idle, prompt available")

			terminal.submit("/ferment progress")
			trace.step("opened /ferment progress")

			await waitForText(terminal, "Progress Overlay Test", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("overlay shows ferment name")

			await waitForText(terminal, /[█░]/, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("progress bar visible")

			await waitForText(terminal, "Implementation", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("phase list visible")

			await waitForText(terminal, "now:", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("now line visible")

			await waitForText(terminal, "1/2", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("step count visible")
		},
	)
})

test("/ferment progress overlay shows step count after completing a step", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-progress-overlay-step-count",
			gitInit: true,
			responses: [
				{ stream: ["I'll outline the scope."], toolCalls: [{ function: { name: "propose_ferment_scoping", arguments: PROPOSE_SCOPING_PAYLOAD } }] },
				{ stream: ["I've outlined the scope."] },
				{},
				ACTIVATE_PHASE,
				START_STEP_1,
				COMPLETE_STEP_1,
				START_STEP_2,
				...WAITING,
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			terminal.submit("Verify progress overlay")
			trace.step("submitted intent")

			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			await waitForText(terminal, "Tip: Open Ferment progress", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("agent idle, prompt available")

			terminal.submit("/ferment progress")
			trace.step("opened /ferment progress")

			await waitForText(terminal, "1/2", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("shows 1/2 steps after completion")
		},
	)
})
