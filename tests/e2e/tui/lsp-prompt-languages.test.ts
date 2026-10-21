import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Availability line rendered by the lsp-tools system-prompt block when a
 *  server is active for the session — must name the active language, not a
 *  hardcoded list (the stale text claimed "currently TypeScript and Go" even
 *  in Python sessions after pyright support landed). */
const ACTIVE_LANGUAGE_LINE = "this session: Python"

/** The stale hardcoded claim the derived line replaced — must be gone. */
const STALE_LANGUAGE_CLAIM = "currently TypeScript and Go"

/** Returns true if any recorded provider request body contains the phrase. */
function anyRequestContains(fixture: KimchiFixture, phrase: string): boolean {
	for (const request of fixture.fake.requests) {
		const bodyText = JSON.stringify(request.body ?? "")
		if (bodyText.includes(phrase)) return true
	}
	return false
}

test("LSP system prompt names the session's active language in a Python project", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "lsp-active-python",
			responses: [{ stream: ["Done."] }],
			env: { KIMCHI_LSP_BINARIES: "pyright-langserver" },
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "pyproject.toml"), '[project]\nname = "test"\nversion = "0.1.0"\n')
			},
		},
		async (fixture, trace) => {
			trace.step("checking status line for active LSP status")
			// Poll instead of snapshotting: footer statuses are applied
			// asynchronously during session_start, so an immediate read can
			// race the render.
			await waitForText(terminal, "pyright", { full: false })

			terminal.submit("hello")
			trace.step("submitted prompt")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("settled")

			// The availability line must derive from the session's active
			// servers (pyright → Python), and the stale hardcoded claim must
			// be gone from every provider request.
			expect(anyRequestContains(fixture, ACTIVE_LANGUAGE_LINE)).toBe(true)
			expect(anyRequestContains(fixture, STALE_LANGUAGE_CLAIM)).toBe(false)
		},
	)
})
