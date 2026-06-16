import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Drives the ferment scoping flow to the "Review the proposed phases" picker to
// prove the separator line ("─────") is selectable/navigable (bug report).
test("ferment phase-review separator is not selectable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-phase-review",
			gitInit: true,
			responses: [
				// Turn triggered by the scoping nudge: model proposes scoping.
				{
					toolCalls: [
						{
							id: "call_scope",
							function: {
								name: "propose_ferment_scoping",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									title: "Streaming think parser",
									goal: "Parse <think> tags in both proxy adapters",
									success_criteria: ["Streaming parser emits think deltas"],
									phases: [{ name: "Implement streaming <think> parser", goal: "Add a streaming parser" }],
									questions: [],
									gates: [
										{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "tests pass" },
										{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
										{ id: "P3", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
									],
								}),
							},
						},
					],
				},
				// Follow-up message after the tool result: a question ending in "?" so the
				// host renders the draft-confirmation dropdown at turn_end.
				{ stream: ["Here is the proposed plan. Does this look right?"] },
			],
		},
		async (_fixture, trace) => {
			// Stage 1: enter ferment mode -> intent prompt.
			terminal.submit("/ferment")
			trace.step("submitted /ferment")
			await waitForText(terminal, "What would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			// Stage 2: submit intent -> model proposes scoping -> draft-confirm dropdown.
			terminal.submit("Implement streaming think parser")
			trace.step("submitted intent")
			await waitForText(terminal, "Yes, this looks right", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("draft-confirm dropdown visible")

			// Stage 3: pick "Yes, this looks right" (first option) -> phase-review picker.
			terminal.submit("")
			trace.step("selected 'Yes, this looks right'")
			await waitForText(terminal, "Review the proposed phases", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Confirm and start", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("phase-review picker visible")

			// Stage 4 (the bug): items are [phase, ─────, + Add phase, ✓ Confirm, ✗ Cancel].
			// From the phase (cursor at index 0), one Down should reach "+ Add phase".
			// With the bug the divider is selectable, so Down lands on it and Enter is a
			// no-op (the picker just re-renders) — the add-phase prompt never opens.
			terminal.keyDown()
			trace.step("pressed down once from the first phase")
			terminal.submit("")
			trace.step("pressed enter on the item below the first phase")
			await waitForText(terminal, "New phase name", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("add-phase prompt opened (separator was skipped)")
		},
	)
})
