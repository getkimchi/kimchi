import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("status panel opens and dismisses on a key press", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "status-panel", responses: [] }, async (_fixture, trace) => {
		// Write then submit separately so the command is visible before Enter fires.
		terminal.write("/status")
		await waitForText(terminal, "/status", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("typed /status")
		terminal.submit("")

		// The Status panel shows a snapshot of version → login → session/model/MCP.
		await waitForText(terminal, "Status", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("status panel open")

		await expect(terminal.getByText("Version:")).toBeVisible()
		await expect(terminal.getByText("Login method:")).toBeVisible()
		await expect(terminal.getByText("Session ID:")).toBeVisible()
		await expect(terminal.getByText("Model:")).toBeVisible()
		await expect(terminal.getByText("MCP servers:")).toBeVisible()
		await expect(terminal.getByText("press any key to close")).toBeVisible()
		trace.step("all rows visible")

		// Unnamed session shows the /name hint.
		await expect(terminal.getByText("(unnamed — use /name to add a name)")).toBeVisible()
		trace.step("unnamed-session hint visible")

		// Any key dismisses and restores the prompt.
		terminal.keyEscape()
		await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("dismissed — prompt restored")
	})
})
