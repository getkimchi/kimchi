import { test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// LLM-2071: the cooking/braising spinner must stay visible throughout streaming,
// including between slow tokens, not just before the first token and after the
// last. Before the fix, message_start for the assistant tore down the spinner
// the moment text started streaming, so the TUI appeared frozen on slow models.
//
// We stream 6 tokens with 600 ms inter-token delay. The test asserts the spinner
// is visible mid-stream (after the first chunk lands) and is gone after the turn
// completes (replaced by the "Worked for Xs" turn_end status).
test("cooking spinner stays visible during slow text streaming", async ({ terminal }) => {
	// Match a cooking verb followed by an animation dot — only the cooking animator
	// appends dots ("Stirring.", "Stirring..", "Stirring..."). The response text
	// never has this pattern (e.g. it has "Stirring the", not "Stirring.").
	const spinnerPattern =
		/(?:Stirring|Marinating|Chopping|Braising|Salting|Rinsing|Simmering|Seasoning|Tasting|Cooking|Grinding|Packing|Massaging|Reducing|Prepping|Chilling|Building|Letting|Mixing|Tossing)\.(?:\s|$)/

	await runKimchiSession(
		terminal,
		{
			artifactName: "spinner-persistence",
			responses: [
				{
					// 600 ms between each token — slow enough that pre-fix the user
					// sees a frozen TUI for most of the response.
					stream: ["Stirring ", "the ", "kimchi ", "pot ", "very ", "slowly."],
					delayMs: 600,
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Stir the kimchi")
			trace.step("submitted prompt")

			// Wait for the first chunk — streaming has started but isn't done yet.
			// ~600ms delay means we'll catch this mid-stream.
			await waitForText(terminal, "Stirring the", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("first response chunk visible")

			// The cooking spinner must STILL be visible while text is streaming.
			// Pre-fix: spinner would already have been torn down by message_start.
			await waitForText(terminal, spinnerPattern, {
				timeoutMs: 2_000,
			})
			trace.step("cooking spinner visible during streaming")

			// Wait for the full response to complete (~3.6s of streaming).
			await waitForText(terminal, "Stirring the kimchi pot very slowly.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("full response visible")

			// After the turn completes (agent_end), the spinner should be replaced
			// by the "Worked for Xs" turn_end status.
			await waitForText(terminal, "Worked for", { timeoutMs: 5_000 })
			trace.step("turn_end status visible — spinner cleared")
		},
	)
})
