/**
 * E2E TUI test: an org policy that allows only plan mode cannot run Ferment.
 *
 * `/ferment <goal>` must tell the user why, and must not send any request to
 * the model, because a Ferment run cannot execute in a read-only mode.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("/ferment refuses to start when the org allows only plan mode", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-ferment-plan-only",
			policy: { modes: { plan: true, default: false, auto: false, yolo: false } },
			responses: [],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			terminal.submit("/ferment build a cache")
			await waitForText(terminal, "only allows plan mode, so Ferment cannot run", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("policy refusal shown")

			// Let any wrongly queued turn reach the fake server before checking.
			await new Promise((resolve) => setTimeout(resolve, 1_500))
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions")),
			).toHaveLength(0)
			trace.step("no model request was sent")
		},
	)
})
