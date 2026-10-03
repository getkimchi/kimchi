import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("relayed console warnings aggregate into one collapsed transcript row that scrolls with history", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "warnings-summary-collapse",
			responses: [{ stream: ["Done."] }],
			// Test-only extension: emits two console.warn calls from a session_start
			// handler — the startup-warning scenario the relay exists for. The rows
			// must appear live. Guarded to once per process: the fixture boots the
			// session more than once (trust/restart cycles), and re-dispatched
			// session_start events would otherwise multiply the warnings.
			extraArgs: ["--extension", "./e2e-warn-extension.js"],
			seedHome(_homeDir, workDir) {
				writeFileSync(
					join(workDir, "e2e-warn-extension.js"),
					[
						"export default function (pi) {",
						'\tpi.on("session_start", () => {',
						"\t\tif (globalThis.__e2eWarnFired) return",
						"\t\tglobalThis.__e2eWarnFired = true",
						'\t\tconsole.warn("e2e seeded warning one")',
						'\t\tconsole.warn("e2e seeded warning two")',
						"\t})",
						"}",
						"",
					].join("\n"),
					"utf-8",
				)
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { full: true })

			// The two co-occurring seeded warns aggregate into one collapsed group
			// row after the ~1.5s window — the earlier one stays hidden behind the
			// Latest: of the later one until expanded.
			await waitForText(terminal, "warnings] Latest: e2e seeded warning two", { full: true })
			expect(fullText(terminal)).toContain("(ctrl+o to expand)")
			expect(fullText(terminal)).not.toContain("e2e seeded warning one")
			trace.step("one aggregated collapsed row; earlier warning hidden, no widget")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "e2e seeded warning one", { full: true })
			trace.step("ctrl+o expands the grouped warning list")

			// The row scrolls with history — submitting a prompt leaves it in
			// scrollback and nothing stays pinned under the editor.
			terminal.submit("hello")
			await waitForText(terminal, "Done.")
			expect(fullText(terminal)).toContain("e2e seeded warning one")
			trace.step("rows remain in scrollback after the prompt")
		},
	)
})
