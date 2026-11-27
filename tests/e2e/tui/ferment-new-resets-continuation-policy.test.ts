/**
 * E2E TUI regression: continuation policy choices do not leak into a newly
 * created interactive ferment.
 *
 * Flow:
 * 1. Create an interactive draft ferment.
 * 2. Change that ferment to automated continuation.
 * 3. Create another interactive ferment.
 * 4. Its acknowledgement reports the default manual policy.
 */

import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { FERMENT_LEGACY_ENV, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a new interactive ferment resets automated continuation to manual", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-new-resets-continuation-policy",
			env: FERMENT_LEGACY_ENV,
			gitInit: true,
			responses: [{ stream: ["The old ferment draft is ready."] }, { stream: ["The new ferment draft is ready."] }],
		},
		async (_fixture, trace) => {
			terminal.keyBackspace(200)
			terminal.write('/ferment-legacy new "Old Ferment"')
			await waitForText(terminal, '/ferment-legacy new "Old Ferment"', { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "The old ferment draft is ready.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("created the old interactive ferment")

			terminal.keyBackspace(200)
			terminal.write("/ferment-legacy auto")
			await waitForText(terminal, "/ferment-legacy auto", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, 'Continuation policy set to automated for "Old Ferment".', {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("set the old ferment continuation policy to automated")

			terminal.keyBackspace(200)
			terminal.write('/ferment-legacy new "New Ferment"')
			await waitForText(terminal, '/ferment-legacy new "New Ferment"', { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, /Started ferment: "New Ferment"[\s\S]*Policy: manual/, {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("new interactive ferment started with manual continuation policy")
		},
	)
})
