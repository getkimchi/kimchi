import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("relayed console warnings render as one collapsed row that expands with ctrl+o", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "warnings-summary-collapse",
			responses: [{ stream: ["Done."] }],
			// Test-only extension: emits two console.warn calls from a session_start
			// handler — the startup-warning scenario the relay exists for. The row
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

			// Collapsed: a single dim summary row. The exact count N is not
			// asserted — the fixture environment emits its own real startup
			// warnings (e.g. [model-roles]) that legitimately share the row;
			// only the seeded tail is deterministic. The first warning stays
			// hidden behind the Latest: of the most recent one.
			await waitForText(terminal, "warnings] Latest: e2e seeded warning two", { full: true })
			await waitForText(terminal, "(ctrl+o to expand)", { full: true })
			expect(fullText(terminal)).not.toContain("e2e seeded warning one")
			trace.step("one collapsed warnings row; earlier warning hidden")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "[Warnings]", { full: true })
			await waitForText(terminal, "(ctrl+o to collapse)", { full: true })
			await waitForText(terminal, "e2e seeded warning one", { full: true })
			trace.step("ctrl+o expands the full warning list")
		},
	)
})
