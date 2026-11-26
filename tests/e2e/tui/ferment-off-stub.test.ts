/**
 * E2E TUI test: with Ferment turned off, `/ferment` is only a stub.
 *
 * Without the stub, `/ferment refactor auth` would go to the model as a
 * normal prompt. The stub tells the user how to turn Ferment on instead.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { harnessSettingsPath, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("/ferment explains how to turn Ferment on when it is off", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-off-stub",
			responses: [],
			seedHome(homeDir) {
				const settingsPath = harnessSettingsPath(homeDir)
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { resources?: Record<string, boolean> }
				settings.resources = { ...settings.resources, "extensions.ferment": false }
				writeFileSync(settingsPath, JSON.stringify(settings, null, "\t"))
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment refactor auth")
			// The warning wraps at 120 columns, so match pieces that fit on one row.
			await waitForText(terminal, "/ferment needs Ferment, which is off.", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "kimchi resources enable extensions.ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Then restart kimchi to load it.", { timeoutMs: INPUT_TIMEOUT_MS })
			expect(fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))).toHaveLength(0)
			trace.step("stub shows how to turn Ferment on and nothing goes to the model")
		},
	)
})
