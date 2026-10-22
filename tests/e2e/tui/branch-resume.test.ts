import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

// The /session info block (~25 rows) stacks on top of startup warnings, the
// replayed turn, and the branch box. At 40 rows the asserted Name:/ID: lines can
// land just above the viewport fold, and these waits intentionally assert on the
// visible screen (full: false) because the pre-resume /session output for the
// same session is still in scrollback after the -r relaunch and would false-match
// a full-buffer scan. Extra rows keep the block on screen.
test.use({ ...TUI_TEST_CONFIG, rows: 60 })

test("branch creates a named resumable session for -r", async ({ terminal }) => {
	const exitMarker = "__KIMCHI_BRANCH_FIRST_SESSION_EXITED__"
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
	})

	try {
		launchKimchi(terminal, fixture, [], {}, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("hello")
		await waitForText(terminal, "Hello from fake Kimchi.", { timeoutMs: STREAM_TIMEOUT_MS })

		const branchName = "parser spike"
		terminal.submit(`/branch ${branchName}`)
		await waitForText(terminal, "[kimchi-session-branch]")
		await waitForText(terminal, /You can resume a branch of this session with -r [0-9a-f-]{36}/)

		const match = fullText(terminal).match(/You can resume a branch of this session with -r ([0-9a-f-]{36})/)
		expect(match).not.toBeNull()
		const sessionId = match?.[1]

		terminal.submit("/session")
		await waitForText(terminal, new RegExp(`Name:\\s*${escapeRegExp(branchName)}`), {
			timeoutMs: STARTUP_TIMEOUT_MS,
			full: false,
		})

		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		launchKimchi(terminal, fixture, ["-r", sessionId])
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("/session")
		await waitForText(terminal, new RegExp(`ID:\\s*${escapeRegExp(sessionId)}`), {
			timeoutMs: STARTUP_TIMEOUT_MS,
			full: false,
		})
		await waitForText(terminal, new RegExp(`Name:\\s*${escapeRegExp(branchName)}`), {
			timeoutMs: STARTUP_TIMEOUT_MS,
			full: false,
		})
	} finally {
		try {
			await stopKimchi(terminal)
		} catch {
			/* best-effort */
		}
		try {
			await fixture.stop()
		} catch {
			/* best-effort */
		}
	}
})

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
