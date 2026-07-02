import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, fullText, waitForText } from "./support/assertions.js"
import {
	PROMPT_READY,
	TUI_TEST_CONFIG,
	createKimchiFixture,
	launchKimchi,
	stopKimchi,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("branch creates a named resumable session for -r", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
	})

	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		terminal.submit("hello")
		await waitForText(terminal, "Hello from fake Kimchi.", { timeoutMs: STREAM_TIMEOUT_MS })

		const branchName = "parser spike"
		terminal.submit(`/branch ${branchName}`)
		await waitForText(terminal, "[kimchi-session-branch]")
		await waitForText(terminal, /You can resume a branch of this session with -r [0-9a-f-]{36}/)

		const match = fullText(terminal).match(/You can resume a branch of this session with -r ([0-9a-f-]{36})/)
		expect(match).not.toBeNull()
		const sessionId = match![1]

		terminal.submit("/session")
		await waitForText(terminal, new RegExp(`Name:\\s*${escapeRegExp(branchName)}`), {
			timeoutMs: STARTUP_TIMEOUT_MS,
			full: false,
		})

		terminal.submit("/quit")
		await new Promise((resolve) => setTimeout(resolve, 500))

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
