/**
 * E2E TUI tests for the /memory list interactive browser.
 *
 * Covers the user workflow end to end: /memory list opens the MemoryPanel
 * over the seeded personal store, the cursor moves with the arrow keys, `d`
 * deletes the selected fact immediately, quitting returns to the prompt,
 * and re-opening the browser shows the deletion persisted.
 */
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

const FACTS = [
	{ id: "e2e-fred", text: "the user's dog is named Fred" },
	{ id: "e2e-lisbon", text: "the user lives in Lisbon" },
	{ id: "e2e-helix", text: "the user's favorite editor is helix" },
]

test("/memory list opens the interactive browser; paging and deleting by selection", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-panel-browse-delete",
			responses: [],
			extraArgs: ["--memory"],
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, FACTS)
			},
		},
		async (_fixture, trace) => {
			terminal.write("/memory list")
			await waitForText(terminal, "/memory list")
			terminal.submit("")
			await waitForText(terminal, "Memory — 3 facts", { full: false })
			trace.step("browser opened with the three seeded facts")

			await waitForText(terminal, "dog is named Fred", { full: false })
			await waitForText(terminal, "d delete", { full: false })

			// Move to the second fact and delete it by selection.
			terminal.keyDown()
			terminal.keyPress("d")
			await waitForText(terminal, "Deleted from personal: the user lives in Lisbon", { full: false })
			trace.step("second fact deleted by selection")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			trace.step("browser closed back to the prompt")

			// The deletion persisted: the browser now shows two facts.
			terminal.submit("/memory list")
			await waitForText(terminal, "Memory — 2 facts", { full: false })
			const view = viewText(terminal)
			expect(view).toContain("dog is named Fred")
			expect(view).not.toContain("lives in Lisbon")
			trace.step("re-opened browser shows the deletion persisted")
		},
	)
})
