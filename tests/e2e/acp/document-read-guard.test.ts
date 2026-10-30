// ACP integration: the document intake guard is surface-independent. A `read`
// call on a binary .pdf is blocked and the redirect reason reaches the model
// as the tool result — the ACP client sees the same tool_call_update the TUI
// renders, and no decoded binary enters the model request.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/** Binary PDF body: %PDF- head plus bytes that decode as U+FFFD. */
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), Buffer.alloc(2048, 0xff)])

describe("ACP integration — document read guard", () => {
	let fixture: Awaited<ReturnType<typeof startAcpFixture>>

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "document-read-guard-acp",
			responses: [
				{
					stream: ["Looking at the contract."],
					toolCalls: [
						{
							id: "call_read_pdf",
							function: { name: "read", arguments: JSON.stringify({ path: "contract.pdf" }) },
						},
					],
				},
				{ stream: ["Redirected to the pdf skill."] },
			],
		})
		writeFileSync(join(fixture.workDir, "contract.pdf"), PDF_BYTES)
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("blocks read on a binary pdf and returns the doc-cli redirect to the model", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Find the termination clause in the contract")
		expect(result.stopReason).toBe("end_turn")

		// The client-visible tool_call_update carries the redirect reason.
		const updates = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call_update",
		)
		expect(JSON.stringify(updates)).toContain("kimchi doc-cli pdf read contract.pdf")

		// The model's continuation request carries the same tool result and
		// never the decoded binary.
		const continuation = fixture.fake.requests.find(
			(request) =>
				Array.isArray((request.body as { messages?: Array<{ tool_call_id?: string }> })?.messages) &&
				(request.body as { messages: Array<{ tool_call_id?: string }> }).messages.some(
					(m) => m.tool_call_id === "call_read_pdf",
				),
		)
		expect(continuation).toBeDefined()
		const body = JSON.stringify(continuation?.body)
		expect(body).toContain("is a binary PDF file")
		expect(body).not.toContain("\uFFFD")
	})
})
