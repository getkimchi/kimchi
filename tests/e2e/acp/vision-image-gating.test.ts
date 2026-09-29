import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

// End-to-end coverage for the ACP vision support fallback: image blocks on a
// text-only model are dropped server-side and surfaced to the client as a
// standard agent_message_chunk warning, while vision-capable (and auto-routed)
// models keep their images all the way to the backend.

/** Minimal valid 1x1 PNG, matching the fixture used by the MCP e2e suites. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function imageBlock(): acp.ContentBlock {
	return { type: "image", data: TINY_PNG, mimeType: "image/png" }
}

// All agent_message_chunk text updates for a session, in arrival order, with
// their (optional) message ids. Non-text chunks are skipped — they carry no
// text to assert on.
function textChunks(fixture: AcpFixture, sessionId: string): Array<{ text: string; messageId?: string | null }> {
	return fixture.client.sessionUpdates.flatMap(({ sessionId: sid, update }) => {
		if (sid !== sessionId || update.sessionUpdate !== "agent_message_chunk") return []
		if (update.content.type !== "text") return []
		return [{ text: update.content.text, messageId: update.messageId }]
	})
}

// The recorded chat-completion request bodies hitting the fake backend.
function chatBodies(fixture: AcpFixture): unknown[] {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => request.body)
}

describe("ACP vision image gating", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("drops image blocks on a text-only model and warns the client before the response", async () => {
		// A vision model stays available so the connection legitimately
		// advertises image support; the session's concrete model is text-only.
		fixture = await startAcpFixture({
			artifactName: "acp-vision-drop",
			models: [
				{ slug: "text-only-model", displayName: "Text Only" },
				{ slug: "vision-model", displayName: "Vision Model", input: ["text", "image"] },
			],
			defaultModel: "text-only-model",
			responses: [{ stream: ["I only got the words."] }],
		})

		expect(fixture.initializeResponse.agentCapabilities?.promptCapabilities?.image).toBe(true)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "describe this image", [imageBlock()])
		expect(result.stopReason).toBe("end_turn")

		// The scripted response arrived, preceded by exactly one drop warning.
		const chunks = textChunks(fixture, sessionId)
		expect(chunks.map((chunk) => chunk.text)).toContain("I only got the words.")
		const warnings = chunks.filter((chunk) => chunk.text.startsWith("[ACP]"))
		expect(warnings).toHaveLength(1)
		expect(warnings[0].text).toContain("[ACP] dropped 1 image block")
		expect(warnings[0].text).toContain("text-only-model does not accept image input")
		// The warning lands before any assistant content and keeps its own
		// message-id namespace plus a blank-line separator.
		expect(chunks.indexOf(warnings[0])).toBeLessThan(
			chunks.findIndex((chunk) => chunk.text === "I only got the words."),
		)
		expect(warnings[0].messageId).toMatch(/^acp-warning\./)
		expect(warnings[0].text.endsWith("\n\n")).toBe(true)
		expect(warnings[0].text + "I only got the words.").toContain("file path.\n\nI only got the words.")

		// The backend saw the text — and never the image.
		const bodies = chatBodies(fixture)
		expect(bodies).toHaveLength(1)
		const userMessage = JSON.stringify(
			(bodies[0] as { messages: Array<{ role: string }> }).messages.find((message) => message.role === "user"),
		)
		expect(userMessage).toContain("describe this image")
		expect(userMessage).not.toContain("image_url")
		expect(userMessage).not.toContain(TINY_PNG)
	})

	it("delivers image blocks to the backend on a vision-capable model", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-vision-pass",
			modelInput: ["text", "image"],
			responses: [{ stream: ["Image received."] }],
		})

		expect(fixture.initializeResponse.agentCapabilities?.promptCapabilities?.image).toBe(true)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "describe this image", [imageBlock()])
		expect(result.stopReason).toBe("end_turn")

		// No drop warning — the image went through.
		expect(fixture.client.acpWarnings()).toEqual([])
		const chunks = textChunks(fixture, sessionId)
		expect(chunks.map((chunk) => chunk.text)).toContain("Image received.")

		// The submitted payload reached the fake backend as an image part.
		const bodies = chatBodies(fixture)
		expect(bodies).toHaveLength(1)
		const userMessage = JSON.stringify(
			(bodies[0] as { messages: Array<{ role: string }> }).messages.find((message) => message.role === "user"),
		)
		expect(userMessage).toContain(`data:image/png;base64,${TINY_PNG}`)
	})

	it("advertises image support for an Auto-only registry with text-only descriptors", async () => {
		// Auto is backend-routed: the descriptor says text-only, but the routed
		// pool accepts images, so the connection must advertise image support.
		fixture = await startAcpFixture({
			artifactName: "acp-vision-auto-advertisement",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: [
				{
					slug: "routed",
					displayName: "Fake Routed",
					provider: "ai-enabler",
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
				{
					slug: "auto",
					displayName: "Auto",
					provider: "ai-enabler",
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
			responses: [],
		})

		expect(fixture.initializeResponse.agentCapabilities?.promptCapabilities?.image).toBe(true)
	})
})
