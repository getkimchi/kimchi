/**
 * E2E TUI test for the memory status-line segment — the no-delivery path.
 *
 * The fixture's fake provider rejects embeddings, so no search can ever
 * deliver facts in the real binary (see memory-overview-widget.test.ts for
 * the same expectation). What this proves end-to-end: with the memory
 * feature on but nothing delivered, the status line carries no `memory:`
 * segment — no layout shift before first recall — and retrieval errors stay
 * off the terminal. The positive path (the segment rendering the delivered
 * fact count from the extension status) is owned by the unit tests in
 * src/components/status-line.test.ts and src/extensions/memory/extension.test.ts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { seedMemoryHome } from "./support/memory-e2e.js"

test.use(TUI_TEST_CONFIG)

test("the status line shows no memory segment when nothing was recalled", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "memory-recall-status",
			responses: [
				{ stream: ["Nothing recalled — the agent carried on without memory."] },
				{ stream: ["Still nothing — the toggle never produced a count."] },
			],
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.memory" },
			seedHome: (homeDir) => {
				seedMemoryHome(homeDir, [
					{ id: "e2e-fred", text: "the user's dog is named Fred" },
					{ id: "e2e-lisbon", text: "the user lives in Lisbon" },
				])
			},
		},
		async (fixture, trace) => {
			// First exchange: the digest lookup runs and fails (the fake provider
			// rejects embeddings) — no facts delivered, so the segment must not
			// exist and nothing may shift the status line.
			terminal.submit("hello there")
			await waitForText(terminal, "Nothing recalled — the agent carried on without memory.")
			expect(viewText(terminal)).not.toContain("memory:")
			expect(viewText(terminal)).not.toContain("Error embedding text")
			trace.step("no memory segment after the failed first lookup")

			// The retrieval really ran — the failure is in the log, proving the
			// absence above is the no-delivery path, not memory never starting.
			expect(readFileSync(join(fixture.agentDir, "logs", "tui.log"), "utf8")).toContain(
				"Error embedding text with Langchain Embedder",
			)

			// /memory disable, then another exchange: still no segment — the
			// toggle path clears the count rather than setting one.
			terminal.write("/memory disable")
			await waitForText(terminal, "/memory disable")
			terminal.submit("")
			await waitForText(terminal, "Memory disabled for this session")

			// Another exchange with memory disabled — the toggle path clears
			// the count rather than setting one, so still no segment.
			terminal.submit("one more thing")
			await waitForText(terminal, "Still nothing — the toggle never produced a count.")
			expect(viewText(terminal)).not.toContain("memory:")
			trace.step("no memory segment after /memory disable")
		},
	)
})
