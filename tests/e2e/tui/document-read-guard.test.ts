// Document intake e2e (TUI): binary documents never reach the model as UTF-8
// garbage. Two user-visible paths:
//  1. The model calls `read` on a binary .pdf mid-task — the call is blocked
//     and the model receives the doc-cli redirect instead of raw bytes.
//  2. The session is launched with `@contract.pdf …` — upstream @file inlining
//     is replaced by a one-line stub in the first prompt.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Binary PDF body: %PDF- head plus bytes that decode as U+FFFD — exactly the
 *  garbage the guard exists to keep out of the model's context. */
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), Buffer.alloc(2048, 0xff)])

function requestContainsToolResult(body: unknown, toolCallId: string): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return false
	return messages.some(
		(message) =>
			Boolean(message && typeof message === "object") &&
			(message as Record<string, unknown>).role === "tool" &&
			(message as Record<string, unknown>).tool_call_id === toolCallId,
	)
}

test("read on a binary pdf is blocked with the doc-cli redirect", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "document-read-guard-read-redirect",
			seedHome: (_homeDir, workDir) => {
				writeFileSync(join(workDir, "contract.pdf"), PDF_BYTES)
			},
			responses: [
				{
					stream: ["Looking at the contract."],
					toolCalls: [
						{
							id: "call_read_pdf",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "contract.pdf" }),
							},
						},
					],
				},
				{ stream: ["Redirected to the pdf skill."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Find the termination clause in the contract")
			await waitForText(terminal, "Redirected to the pdf skill.", { timeoutMs: STREAM_TIMEOUT_MS })

			const continuation = fixture.fake.requests.find((request) =>
				requestContainsToolResult(request.body, "call_read_pdf"),
			)
			expect(continuation).toBeDefined()
			const body = JSON.stringify(continuation?.body)
			expect(body).toContain("is a binary PDF file")
			expect(body).toContain("kimchi doc-cli pdf read contract.pdf")
			expect(body).not.toContain("\uFFFD")
			trace.step("read on the binary pdf returned the redirect, not raw bytes")
		},
	)
})

test("@file launch stubs the binary pdf instead of inlining it", async ({ terminal }) => {
	// The @file argument must exist before argv parsing, so the pdf lives in
	// the test's own temp dir (the fixture workDir is created later).
	const pdfDir = mkdtempSync(join(tmpdir(), "kimchi-e2e-atfile-"))
	try {
		const pdfPath = join(pdfDir, "contract.pdf")
		writeFileSync(pdfPath, PDF_BYTES)

		await runKimchiSession(
			terminal,
			{
				artifactName: "document-read-guard-atfile-stub",
				extraArgs: [`@${pdfPath}`, "Summarize"],
				responses: [{ stream: ["Summarized the stub."] }],
			},
			async (fixture, trace) => {
				await waitForText(terminal, "Summarized the stub.", { timeoutMs: STREAM_TIMEOUT_MS })

				// The fake records every HTTP request (telemetry, api-key verify);
				// the first one carrying `messages` is the initial model call.
				const first = fixture.fake.requests.find((r) =>
					Array.isArray((r.body as { messages?: unknown } | undefined)?.messages),
				)
				expect(first).toBeDefined()
				// Assert on the decoded user message (a content-block array for this
				// provider): JSON.stringify would escape the quotes asserted below.
				const user = (first?.body as { messages?: Array<{ role: string; content: unknown }> })?.messages?.find(
					(m) => m.role === "user",
				)
				const prompt = Array.isArray(user?.content)
					? user.content.map((b) => (b && typeof b === "object" && "text" in b ? b.text : "")).join("")
					: ((user?.content as string | undefined) ?? "")
				// The whole point: the 2 KB binary never lands in the prompt.
				expect(prompt).not.toContain("\uFFFD")
				expect(prompt).toContain(`<file name="${pdfPath}">`)
				expect(prompt).toContain("[binary PDF file, 2 KB, not inlined.")
				expect(prompt).toContain(`kimchi doc-cli pdf read ${pdfPath}`)
				expect(prompt).toContain("Summarize")
				trace.step("the @file prompt carried the stub, not the document bytes")
			},
		)
	} finally {
		rmSync(pdfDir, { recursive: true, force: true })
	}
})
