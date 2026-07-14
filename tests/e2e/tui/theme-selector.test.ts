import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E tests for the /theme command (themeSelectorExtension).
 *
 * The theme selector is a built-in extension registered in cli.ts — no
 * --extension flag is required. The command opens a SelectList over all
 * available themes with live preview on arrow-key navigation. Tests here
 * cover the surface added by the kimchi-dev patch to pi-coding-agent:
 *
 *   - previewTheme(name) — live preview without persisting (on arrow keys /
 *                          on cancel)
 *   - showError(message) — error overlay on failed setTheme (hard to exercise
 *                          with a valid theme list, so not tested here)
 *
 * None of these tests require an LLM response; responses: [] is intentional.
 */

test("theme selector opens and shows available themes", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "theme-selector-opens", responses: [] }, async (_fixture, trace) => {
		// Write then submit separately — one-shot "/theme\r" races startup.
		// Trailing space switches autocomplete to argument mode (no args → cleared),
		// so Enter cannot trigger the slash-command autocomplete accept that doubles
		// the text when the stored prefix is stale.
		terminal.write("/theme ")
		await waitForText(terminal, "/theme ", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("typed /theme")
		terminal.submit("")
		await waitForText(terminal, "Theme", { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("theme selector open")

		// The heading and description should be visible.
		await expect(terminal.getByText("Theme")).toBeVisible()
		await expect(terminal.getByText("Select color theme")).toBeVisible()
		trace.step("heading and description visible")

		// Close via Escape to leave the session in a clean state.
		terminal.keyEscape()
		await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
		trace.step("returned to prompt")
	})
})

test("theme selector escape cancels and restores prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "theme-selector-escape", responses: [] },
		async (_fixture, trace) => {
			terminal.write("/theme ")
			await waitForText(terminal, "/theme ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /theme")
			terminal.submit("")
			await waitForText(terminal, "Theme", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("theme selector open")

			// Navigate down to trigger a previewTheme call, then escape.
			terminal.keyDown()
			trace.step("navigated down (live preview)")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("escape cancelled — prompt restored")

			// Ensure no error overlay leaked into the view.
			expect(terminal.getByText("Error")).not.toBeVisible()
		},
	)
})

test("theme selector enter confirms selection and returns to prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "theme-selector-confirm", responses: [] },
		async (_fixture, trace) => {
			terminal.write("/theme ")
			await waitForText(terminal, "/theme ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /theme")
			terminal.submit("")
			await waitForText(terminal, "Theme", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("theme selector open")

			// Confirm selection on the pre-highlighted (current) theme.
			terminal.submit("")
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("enter confirmed — prompt restored")

			// No error overlay after a valid selection.
			expect(terminal.getByText("Error")).not.toBeVisible()
		},
	)
})
