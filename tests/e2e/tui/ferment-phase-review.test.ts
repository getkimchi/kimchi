import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Bug repro: the phase-review separator is focusable. `test.fail` => expected fail (CI green);
// when fixed it passes unexpectedly and tui-test flags it — the signal to drop `.fail`.
test.fail("ferment phase-review separator is not selectable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-phase-review",
			gitInit: true,
			responses: [
				// Scoping nudge -> model proposes scoping.
				{
					stream: ["I'll outline the scope."],
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
				// Question ending in "?" -> host renders the draft-confirm dropdown at turn_end.
				{ stream: ["Here is the proposed plan. Does this look right?"] },
			],
		},
		async (_fixture, trace) => {
			// Stage 1: enter ferment. Type then Enter separately — one-shot "/ferment\r" can
			// race startup and skip the intent prompt.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
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
			// Down once from the phase should focus "+ Add phase" ("→" marks focus); with the
			// bug "→" parks on the divider, so this wait times out.
			terminal.keyDown()
			trace.step("pressed down once from the first phase")
			await waitForText(terminal, /→\s*\+ Add phase/, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("focus reached '+ Add phase' (separator was skipped)")
		},
	)
})
