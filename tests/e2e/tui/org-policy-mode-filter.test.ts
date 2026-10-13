/**
 * E2E TUI test: the org policy restricts which permission modes exist.
 *
 * The fake platform serves a policy allowing only default + plan (auto/yolo
 * disabled) — delivered over the real path (api-keys:verify + settings:resolve
 * answered by the fake server, fetched at startup, parsed into the holder).
 *
 * Shift+tab cycles default → plan → default: auto and yolo are skipped
 * entirely. With all four modes allowed, two presses would land on auto, so
 * the wrap back to default is only possible under enforcement.
 */

import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("shift+tab cycles only the policy-allowed permission modes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-mode-filter",
			policy: { modes: { plan: true, default: true, auto: false, yolo: false } },
			responses: [{ stream: ["Policy filter session ready."] }],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt — the session is up under the fetched policy.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: the session starts in the config default mode.
			await waitForText(terminal, "default → shift+tab", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("starts in default mode")

			// Stage 3: first cycle — default → plan.
			terminal.write("\x1b[Z")
			await waitForText(terminal, "plan → shift+tab", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("cycled default → plan")

			// Stage 4: second cycle — plan wraps straight back to default. With
			// auto/yolo still in the cycle this press would land on auto instead,
			// so reaching default here proves the modes were filtered.
			terminal.write("\x1b[Z")
			await waitForText(terminal, "default → shift+tab", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("cycled plan → default — auto/yolo were skipped")
		},
	)
})
