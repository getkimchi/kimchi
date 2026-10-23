import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { REPO_ROOT, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const USER_TEXT = "user note that must survive the race"
const ERROR_TEXT = "Specify streamingBehavior"

test("typed message survives a monitor delivery racing the submit", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mid-turn-submit-race",
			responses: [
				{
					// The monitor delivery's turn starts first (it wins the race).
					// Slow the stream so the run is still active when the user's
					// submit clears its input-handler park (+800ms) — with an instant
					// response the flag would be gone again before the check.
					match: (request) => JSON.stringify(request.body).includes("monitor race ping"),
					stream: ["pong", " from", " monitor"],
					textDelayMs: 800,
				},
				{
					// The user's steered message drains into its own turn.
					match: (request) => JSON.stringify(request.body).includes(USER_TEXT),
					stream: ["ack: the note was delivered"],
				},
			],
			extraArgs: ["--extension", join(REPO_ROOT, "tests/e2e/tui/support/mid-turn-race-probe.ts")],
		},
		async () => {
			terminal.submit(USER_TEXT)

			// Whichever way the race resolves, a visible outcome arrives: the
			// steered message's own turn answers, or — only when the bug is
			// present — the runtime's behaviorless-streaming throw does.
			await waitForText(terminal, new RegExp(`(${ERROR_TEXT}|ack: the note was delivered)`))

			// The throw must never surface: the submit queues as steering
			// instead, and its turn runs to a visible answer.
			expect(fullText(terminal)).not.toContain(ERROR_TEXT)
			await waitForText(terminal, "ack: the note was delivered")
			await waitForText(terminal, "pong from monitor")
		},
	)
})
