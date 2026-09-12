/**
 * E2E TUI tests for the /memory overview widget.
 *
 * Covers: the bare /memory command renders store stats as a read-only widget
 * (storage path, per-store fact counts) above the editor, and the widget
 * clears once an agent turn resumes — management output is transient, not
 * permanent UI.
 */
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

test("/memory overview renders store stats as a widget that clears when the agent resumes", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-overview-widget",
			responses: [{ stream: ["The overview widget cleared — the agent resumed."] }],
			extraArgs: ["--memory"],
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, [
					{ id: "e2e-fred", text: "the user's dog is named Fred" },
					{ id: "e2e-lisbon", text: "the user lives in Lisbon" },
				])
			},
		},
		async (_fixture, trace) => {
			terminal.write("/memory")
			await waitForText(terminal, "/memory")
			terminal.submit("")
			await waitForText(terminal, "Memory storage:", { full: false })
			await waitForText(terminal, /personal\s+2\b/, { full: false })
			trace.step("overview widget shows the store stats")

			// A real agent turn clears the widget — it is transient management
			// output, not permanent UI.
			terminal.submit("hello there")
			await waitForText(terminal, "The overview widget cleared — the agent resumed.")
			expect(viewText(terminal)).not.toContain("Memory storage:")
			trace.step("widget cleared when the agent resumed")
		},
	)
})
