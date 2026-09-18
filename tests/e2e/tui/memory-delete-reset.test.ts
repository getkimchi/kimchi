/**
 * E2E TUI tests for /memory delete and reset.
 *
 * Covers: deleting a fact by id (the CLI grammar, no panel), the overview
 * reflecting the remaining count, and reset behind its native confirmation
 * dialog (Enter confirms the default Yes) leaving an empty store.
 */
import { test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

const FACTS = [
	{ id: "e2e-fred", text: "the user's dog is named Fred" },
	{ id: "e2e-lisbon", text: "the user lives in Lisbon" },
	{ id: "e2e-helix", text: "the user's favorite editor is helix" },
]

test("/memory delete removes a fact by id; reset wipes the store after confirmation", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-delete-reset",
			responses: [],
			extraArgs: ["--memory"],
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, FACTS)
			},
		},
		async (_fixture, trace) => {
			// Delete one fact by id — the direct grammar, no panel involved.
			terminal.write("/memory delete e2e-fred")
			await waitForText(terminal, "/memory delete e2e-fred")
			terminal.submit("")
			await waitForText(terminal, "Deleted e2e-fred from personal.", { full: false })
			trace.step("fact deleted by id")

			// The overview reflects the remaining count.
			terminal.submit("/memory")
			await waitForText(terminal, "Memory storage:", { full: false })
			await waitForText(terminal, /personal\s+2\b/, { full: false })
			trace.step("overview shows two facts remaining")

			// Reset opens the native confirmation; Enter confirms the default Yes.
			terminal.write("/memory reset --scope personal")
			await waitForText(terminal, "/memory reset --scope personal", { full: false })
			terminal.submit("")
			await waitForText(terminal, "This permanently deletes 2 fact(s)", { full: false })
			terminal.submit("")
			await waitForText(terminal, "Reset personal: deleted 2 fact(s).", { full: false })
			trace.step("reset confirmed via the dialog")

			// The store is empty now — the overview still lists it, with zero facts
			// (a scoped reset empties the store; the file remains).
			terminal.submit("/memory")
			await waitForText(terminal, /personal\s+0\b/, { full: false })
			trace.step("store empty after reset")
		},
	)
})
