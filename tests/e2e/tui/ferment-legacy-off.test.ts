/**
 * E2E TUI test: a default session runs the new Ferment and hides the legacy one.
 *
 * With no resource overrides, `/ferment` belongs to Ferment (on by default),
 * and the legacy Ferment (V1, `extensions.ferment-legacy`) is off, so its
 * `/ferment-legacy` command is never offered in slash autocomplete.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const FERMENT_DESCRIPTION = "Set or manage a persistent session Ferment"

test("default session: /ferment runs Ferment and /ferment-legacy is not offered", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "ferment-legacy-off", responses: [] }, async (_fixture, trace) => {
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

		// Stage 1: /ferment with no objective reports Ferment's empty state,
		// proving Ferment is on by default and owns /ferment.
		terminal.submit("/ferment")
		await waitForText(terminal, "No Ferment is currently set.", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("/ferment shows Ferment's empty state")

		// Stage 2: the legacy command is not in autocomplete. The /ferment row
		// shows for a shorter prefix, then leaves the list, which proves
		// autocomplete re-filtered for /ferment-legac before the absence check.
		terminal.write("/ferm")
		await waitForText(terminal, FERMENT_DESCRIPTION, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		terminal.write("ent-legac")
		await waitForText(terminal, "/ferment-legac", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		await waitForText(terminal, (text) => !text.includes(FERMENT_DESCRIPTION), {
			timeoutMs: INPUT_TIMEOUT_MS,
			full: false,
		})
		expect(viewText(terminal)).not.toContain("ferment-legacy")
		expect(viewText(terminal)).not.toContain("Legacy Ferment (V1)")
		trace.step("autocomplete offers no ferment-legacy command")
	})
})
