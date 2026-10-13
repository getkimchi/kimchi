// ACP integration: the documents feature (Phase 1: read).
//
// With the toggle on, the read_document tool is advertised to the model, a
// read of a PDF is transparently replaced with extracted Markdown that
// reaches the provider context, and the tool executes per its contract. With
// the toggle off (covered by the default fixture env), none of that happens.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeScannedPdf, makeSimplePdf } from "../../../src/extensions/documents/fixtures/builders.js"
import { type AcpFixture, PROMPT_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — document read", () => {
	let fixture: AcpFixture
	const realEnableEnv = process.env.KIMCHI_ENABLE_RESOURCES

	beforeEach(() => {
		process.env.KIMCHI_ENABLE_RESOURCES = "extensions.documents"
	})

	afterEach(async () => {
		if (realEnableEnv === undefined) delete process.env.KIMCHI_ENABLE_RESOURCES
		else process.env.KIMCHI_ENABLE_RESOURCES = realEnableEnv
		await fixture.stop()
	})

	it(
		"scanned PDF reaches the vision model as image blocks (tool-result forwarding)",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "document-scanned-images-acp",
				models: [{ slug: "vision", displayName: "Fake Vision", provider: "openai", input: ["text", "image"] }],
				responses: [
					{ toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "scan.pdf" }) } }] },
					{ stream: ["scanned read"] },
				],
			})
			writeFileSync(join(fixture.workDir, "scan.pdf"), await makeScannedPdf())
			const sessionId = await newSession(fixture, fixture.workDir)
			expect(await prompt(fixture, sessionId, "read scan.pdf")).toMatchObject({ stopReason: "end_turn" })

			const systemPromptOf = (body: unknown): string => {
				const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
				return messages
					.filter((m) => m.role === "system")
					.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
					.join("\n")
			}
			const chats = fixture.fake.requests
				.filter((r) => r.url.includes("chat/completions"))
				.filter((r) => !systemPromptOf(r.body).includes("Name the user's actual task"))
			expect(chats.length).toBeGreaterThanOrEqual(2)
			const second = JSON.stringify(chats[1].body)
			expect(second).toContain("[page-images] 2 scanned page(s) attached as images.")
			expect(second).toContain('"image_url"')
		},
		PROMPT_TIMEOUT_MS * 3,
	)

	it(
		"read_document is advertised and read interception feeds extracted text into context",
		async () => {
			const pdf = await makeSimplePdf()
			fixture = await startAcpFixture({
				artifactName: "document-read-acp",
				responses: [
					{ toolCalls: [{ function: { name: "read", arguments: JSON.stringify({ path: "report.pdf" }) } }] },
					{ stream: ["got it"] },
				],
			})
			writeFileSync(join(fixture.workDir, "report.pdf"), pdf)
			const sessionId = await newSession(fixture, fixture.workDir)

			expect(await prompt(fixture, sessionId, "read report.pdf")).toMatchObject({ stopReason: "end_turn" })

			const systemPromptOf = (body: unknown): string => {
				const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? []
				return messages
					.filter((m) => m.role === "system")
					.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
					.join("\n")
			}
			// Main conversation turns only — the session-name extension fires its
			// own title-generation chat call per turn (excluded by system prompt).
			const chats = fixture.fake.requests
				.filter((r) => r.url.includes("chat/completions"))
				.filter((r) => !systemPromptOf(r.body).includes("Name the user's actual task"))
			expect(chats.length).toBeGreaterThanOrEqual(2)
			const first = JSON.stringify(chats[0].body)
			const second = JSON.stringify(chats[1].body)
			expect(first).toContain("read_document")
			expect(second).toContain("Hello from page one")
		},
		PROMPT_TIMEOUT_MS * 3,
	)
})
