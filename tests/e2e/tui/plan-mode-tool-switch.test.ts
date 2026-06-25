import { Key, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Dropdown labels (permissions/index.ts:497-499):
//   EXECUTE = "Execute the plan"
//   DECLINE = "Rework the plan"
// Permission-mode cycle order (MODES array, permissions/index.ts:122-128):
//   default → plan → auto → yolo → default
// Session boots in "auto"; shift+tab cycles forward. From auto:
//   shift+tab → yolo, → default, → plan. So 3 presses reach plan mode.
test("plan-mode tool switch: Execute approved plan exits plan mode", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-mode-tool-switch",
			gitInit: true,
			extraArgs: ["--plan=true"], // registered boolean flag in permissions/index.ts:160
			extraEnv: { KIMCHI_PERMISSIONS: "plan" }, // env fallback per permissions/index.ts:200
			responses: [
				// Stream a complete plan ending with the plan-mode marker.
				{
					stream: [
						"Here's a lightweight plan:\n\n",
						"1. Read the relevant source files\n",
						"2. Make the targeted change\n",
						"3. Run tests to verify\n\n",
						"<!-- PLAN_COMPLETE -->\n",
					],
				},
				// After Execute is picked, the model will respond again (now in auto mode).
				{ stream: ["Plan executed. Ready for the next task.\n"] },
			],
		},
		async (_fixture, trace) => {
			// Stage 1: launch, wait for the ready prompt.
			trace.step("waiting for ready prompt")
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")
			trace.step("launched with --plan flag")

			// Precondition: verify plan mode is active (status line shows mode indicator).
			await waitForText(terminal, "plan → shift+tab", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("status line confirms plan mode")

			// Stage 2: submit a trivial request — model responds with a complete plan.
			terminal.submit("Plan out how to add a new feature.")
			trace.step("submitted planning request")
			await waitForText(terminal, "<!-- PLAN_COMPLETE -->", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plan complete marker seen")

			// Stage 4: plan-complete approval dropdown appears (permissions/index.ts:498).
			// NOTE: in this TUI test harness the dropdown overlay is not reliably captured
			// by `terminal.getBuffer()` — we therefore press Enter directly after seeing the
			// PLAN_COMPLETE marker, and rely on the dropdown's `ctx.ui.select(...)` to
			// accept Enter as the default selection of the first option ("Execute the plan").
			// See the parallel test `plan-to-ferment-promo.test.ts` for a `test.fail` that
			// explicitly asserts on the overlay text (with a KNOWN ISSUE comment).
			terminal.keyPress(Key.Enter)
			trace.step("pressed Enter to select default dropdown option ('Execute the plan')")

			// Stage 6: after Execute is picked, the dropdown closes. Assert on the
			// status line mode transition (`plan → shift+tab` → `auto → shift+tab`)
			// instead of the post-execute model response (which is timing-flaky in CI).
			// This proves the dropdown consumed Enter and the session exited plan mode
			// (permissions/index.ts:520: changeMode("plan", "auto", "user")).
			await waitForText(terminal, "auto → shift+tab", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("status line transitioned to auto — dropdown consumed Enter and plan mode exited")
		},
	)
})
