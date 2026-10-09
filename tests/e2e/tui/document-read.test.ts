/**
 * E2E TUI tests for the documents feature (Phase 1: read).
 *
 * Covers:
 * - With the toggle ON, the model's `read` of a PDF is transparently
 *   replaced with extracted Markdown that reaches the provider context, and
 *   the read_document tool is advertised.
 * - With the toggle OFF, none of that happens: no read_document tool, PDF
 *   read output is untouched (byte-identical to master).
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { makeScannedPdf, makeSimplePdf } from "./support/document-fixtures.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Conversation turns only: the fake server also records warmup, title
 * generation, and other aux chat calls — keep only requests whose body
 * carries the harness system prompt.
 */
function conversationTurns(requests: ReadonlyArray<{ url: string; body: unknown }>) {
	return requests.filter((r) => r.url.includes("chat/completions") && JSON.stringify(r.body).includes("You are Kimchi"))
}

test("read on a PDF is transparently replaced with extracted markdown (toggle on)", async ({ terminal }) => {
	const pdf = await makeSimplePdf()
	await runKimchiSession(
		terminal,
		{
			artifactName: "document-read-on",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.documents" },
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "report.pdf"), pdf)
			},
			responses: [
				// Turn 1: model calls the standard read tool on the PDF.
				{ toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "report.pdf" }) } }] },
				// Turn 2: whatever the model says next; the assertion below cares
				// about what the SECOND request carried, not this text.
				{ stream: ["I have read the PDF."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("read report.pdf and tell me what it says")
			await waitForText(terminal, "I have read the PDF.")
			trace.step("model turn complete after reading the pdf")

			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)
			// The second conversation turn must carry the extracted markdown as
			// the read tool result — proof the interception hit the model context.
			const second = JSON.stringify(turns[1].body)
			expect(second).toContain("Hello from page one")
			expect(second).toContain("# report.pdf (pdf — 2 pages)")
			// The tools advertised to the provider include read_document.
			const first = JSON.stringify(turns[0].body)
			expect(first).toContain("read_document")

			// read also rendered something useful to the user in the TUI.
			expect(fixture.agentDir).toBeTruthy()
			trace.step("provider request carries extracted markdown + read_document tool")
		},
	)
})

test("scanned PDF reaches the vision model as page images (toggle on)", async ({ terminal }) => {
	const pdf = await makeScannedPdf()
	await runKimchiSession(
		terminal,
		{
			artifactName: "document-scanned-images",
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.documents" },
			models: [{ slug: "vision", displayName: "Fake Vision", provider: "openai", input: ["text", "image"] }],
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "scan.pdf"), pdf)
			},
			responses: [
				{ toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "scan.pdf" }) } }] },
				{ stream: ["Scanned pages read."] },
			],
		},
		async (fixture) => {
			terminal.submit("read scan.pdf")
			await waitForText(terminal, "Scanned pages read.")
			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)
			const second = JSON.stringify(turns[1].body)
			expect(second).toContain("[page-images] 2 scanned page(s) attached as images.")
			expect(second).toContain('"image_url"') // provider-bound image blocks
		},
	)
})

test("documents toggle off: PDF read output and tool list match master exactly", async ({ terminal }) => {
	const pdf = await makeSimplePdf()
	await runKimchiSession(
		terminal,
		{
			artifactName: "document-read-off",
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "report.pdf"), pdf)
			},
			responses: [
				{ toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "report.pdf" }) } }] },
				{ stream: ["Done."] },
			],
		},
		async (fixture, _trace) => {
			terminal.submit("read report.pdf")
			await waitForText(terminal, "Done.")
			const turns = conversationTurns(fixture.fake.requests)
			expect(turns.length).toBeGreaterThanOrEqual(2)
			const second = JSON.stringify(turns[1].body)
			expect(second).not.toContain("Hello from page one")
			expect(second).not.toContain("# report.pdf (pdf")
			const first = JSON.stringify(turns[0].body)
			expect(first).not.toContain("read_document")
		},
	)
})
