import { expect, test } from "@microsoft/tui-test"
import { Shell } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession } from "./support/kimchi-fixture.js"

// Regression test for the "indicator squeezes the editor" bug.
//
// When the editor is rendered in a narrow terminal and the user types a long
// prompt, every content row must use the full content width — text must NOT
// be wrapped into a narrow column.
//
// The fixture does not expose a clipboard seam, so this test exercises the
// related "long input layout" path. The exact indicator-squeeze regression
// is covered by `src/components/editor.test.ts` (see the
// "does NOT squeeze the editor body when the indicator is set" case).
test.use({ shell: Shell.Bash, rows: 30, columns: 60 })

test("long prompt in narrow terminal does not get squeezed", async ({ terminal }) => {
	const longPrompt = "write a comprehensive test suite for the new authentication module"
	const promptLead = "write a comprehensive" // first words — robust to word-wrap newlines.
	await runKimchiSession(
		terminal,
		{
			artifactName: "editor-narrow-layout",
			responses: [{ stream: ["ok"] }],
		},
		async (_fixture, trace) => {
			terminal.submit(longPrompt)
			trace.step("submitted long prompt")
			// Wait for the leading portion of the prompt — the editor wraps the
			// remainder onto subsequent rows, so the full string will not match.
			await waitForText(terminal, promptLead, { timeoutMs: INPUT_TIMEOUT_MS, full: true })
			trace.step("prompt visible in buffer")

			const buffer = fullText(terminal)
			const lines = buffer.split("\n")
			// Find the cursor row (contains the chevron followed by typed text).
			const cursorRow = lines.find((l) => l.includes("❯") && l.includes(promptLead))
			expect(cursorRow).toBeDefined()

			// The cursor row should use close to the full content width (60 - 2
			// CHEVRON_WIDTH = 58). Pre-fix the indicator squeezed this to ~21.
			const rowWidth = cursorRow ? cursorRow.length : 0
			expect(rowWidth).toBeGreaterThan(40)
		},
	)
})
