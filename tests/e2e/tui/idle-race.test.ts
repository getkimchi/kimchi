// e2e: extension-triggered turns survive async before_agent_start work.
//
// kimchi-workflows steps send messages with { triggerTurn: true } and watch for
// settlement via waitForIdle. Extensions legitimately await async work in
// before_agent_start (memory's turn-1 digest, for example);
// while that work is pending the session must not report idle, or idle watchers
// misread the turn as failed ("became idle without the run settling").
//
// The probe extension (support/idle-race-probe.ts) reproduces the bridge's
// watcher pattern against a 300ms pre-turn delay. On unfixed pi this fires
// IDLE-RACE-CRASHED; with the patch the turn settles and the model replies.

import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { REPO_ROOT, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("idle-probe: extension-triggered turn settles through async before_agent_start", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "idle-race",
			extraArgs: ["--extension", join(REPO_ROOT, "tests/e2e/tui/support/idle-race-probe.ts")],
			responses: [
				// The probe's triggered turn gets the model's reply.
				{ stream: ["IDLE_PROBE_MODEL_REPLY"] },
			],
		},
		async () => {
			terminal.submit("/idle-probe")
			await expect(terminal.getByText("IDLE-RACE-SETTLED", { full: true })).toBeVisible({
				timeout: 15_000,
			})
			// The turn really ran: the model's response rendered too.
			await expect(terminal.getByText("IDLE_PROBE_MODEL_REPLY", { full: true })).toBeVisible({
				timeout: 15_000,
			})
			// And the watcher never fired the pre-fix failure.
			await expect(terminal.getByText("IDLE-RACE-CRASHED")).not.toBeVisible()
		},
	)
})
