/**
 * E2E TUI test: a default session runs the new Ferment, and `/ferment-legacy`
 * is only a stub.
 *
 * With no resource overrides, `/ferment` belongs to Ferment (on by default),
 * and the legacy Ferment (V1, `extensions.ferment-legacy`) is off. A stub owns
 * `/ferment-legacy` so the text never reaches the model as a prompt. The stub
 * tells the user how to turn legacy Ferment on.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const FERMENT_DESCRIPTION = "Set or manage a persistent session Ferment"
const STUB_DESCRIPTION = "Legacy Ferment (V1) is not loaded. Run it to see how to turn it on."
const V1_DESCRIPTION_PREFIX = "Legacy Ferment (V1): /ferment-legacy list"

test("default session: /ferment runs Ferment and /ferment-legacy only explains how to turn it on", async ({
	terminal,
}) => {
	await runKimchiSession(terminal, { artifactName: "ferment-legacy-off", responses: [] }, async (fixture, trace) => {
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

		// Stage 1: /ferment with no objective reports Ferment's empty state,
		// proving Ferment is on by default and owns /ferment.
		terminal.submit("/ferment")
		await waitForText(terminal, "No Ferment is currently set.", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("/ferment shows Ferment's empty state")

		// Stage 2: autocomplete offers the stub, not V1. The /ferment row shows
		// for a shorter prefix, then leaves the list, which proves autocomplete
		// re-filtered for /ferment-legac before the checks.
		terminal.write("/ferm")
		await waitForText(terminal, FERMENT_DESCRIPTION, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		terminal.write("ent-legac")
		await waitForText(terminal, STUB_DESCRIPTION, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
		await waitForText(terminal, (text) => !text.includes(FERMENT_DESCRIPTION), {
			timeoutMs: INPUT_TIMEOUT_MS,
			full: false,
		})
		expect(viewText(terminal)).not.toContain(V1_DESCRIPTION_PREFIX)
		trace.step("autocomplete offers only the /ferment-legacy stub")

		// Stage 3: running the stub warns how to turn legacy on, and nothing
		// goes to the model.
		terminal.write("y list")
		terminal.submit("")
		// The warning wraps at 120 columns, so match pieces that fit on one row.
		await waitForText(terminal, "/ferment-legacy needs the legacy Ferment, which is off.", {
			timeoutMs: INPUT_TIMEOUT_MS,
		})
		await waitForText(terminal, "Then restart kimchi to load it.", { timeoutMs: INPUT_TIMEOUT_MS })
		expect(fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(0)
		trace.step("stub shows how to turn legacy Ferment on")
	})
})
