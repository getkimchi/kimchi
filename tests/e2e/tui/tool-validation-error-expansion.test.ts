import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const RAW_ARGS_SENTINEL = "RAW_ARGS_ONLY_SENTINEL"

test("tool validation error hides raw arguments until tools are expanded", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "tool-validation-error-expansion",
			responses: [
				{
					toolCalls: [
						{
							id: "call_invalid_edit",
							function: {
								name: "edit",
								// Missing required `newText` (plus an unknown key) — a validation failure that
								// does not rely on upstream schemas forbidding additional properties.
								arguments: JSON.stringify({
									path: "example.ts",
									edits: [{ oldText: "before", unexpected: RAW_ARGS_SENTINEL }],
								}),
							},
						},
					],
				},
				{ stream: ["Handled invalid edit arguments."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Try an edit with invalid arguments")

			await waitForText(terminal, "Handled invalid edit arguments.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(fullText(terminal)).toContain('Validation failed for tool "edit"')
			expect(fullText(terminal)).toContain("ctrl+o to expand")
			expect(fullText(terminal)).not.toContain(RAW_ARGS_SENTINEL)
			trace.step("collapsed validation error hides the raw arguments dump")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, RAW_ARGS_SENTINEL, { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).toContain("Received arguments:")
			trace.step("expanded validation error shows the complete raw arguments dump")
		},
	)
})
