import { join } from "node:path"
import { test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { REPO_ROOT, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const extensionPath = join(REPO_ROOT, "tests/e2e/fixtures/remote-completion-extension.js")

test("a finished remote result returns with its original session after /new", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "remote-completion-resume",
			extraArgs: ["--extension", extensionPath],
			env: { KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:1" },
			responses: [{ stream: ["Session A ready."] }, { stream: ["Recovered the remote result in session A."] }],
		},
		async (_fixture, trace) => {
			terminal.submit("hello")
			await waitForText(terminal, "Session A ready.", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("/seed-remote-completion")
			await waitForText(terminal, "Remote completion saved for this session", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("remote completion saved in original session")
			terminal.submit("/new")
			await waitForText(terminal, "New session started", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("new session starts without inheriting the completion")
			terminal.submit("/resume")
			await waitForText(terminal, "Remote completion origin", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.write("Remote completion origin")
			terminal.submit("")
			await waitForText(terminal, "Remote agent run finished. What would you like to do next?", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("original session restores its completion menu")
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Recovered the remote result in session A.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("reviewing the result continues the original conversation")
		},
	)
})
