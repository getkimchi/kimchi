import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

// End-to-end coverage for the ACP vision support fallback: image blocks on a
// text-only model refuse the turn (no model call) and surface a standard
// agent_message_chunk message, while vision-capable (and auto-routed) models
// keep their images all the way to the backend.

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

	it("blocks image prompts on a text-only model and warns the client without a model turn", async () => {
		// A vision model stays available so the connection legitimately
		// advertises image support; the session's concrete model is text-only.
		// No responses are scripted: the blocked prompt must never reach the model.
		fixture = await startAcpFixture({
			artifactName: "acp-vision-drop",
			models: [
				{ slug: "text-only-model", displayName: "Text Only" },
				{ slug: "vision-model", displayName: "Vision Model", input: ["text", "image"] },
			],
			defaultModel: "text-only-model",
			responses: [],
		})

		expect(fixture.initializeResponse.agentCapabilities?.promptCapabilities?.image).toBe(true)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "describe this image", [imageBlock()])
		expect(result.stopReason).toBe("refusal")

		// The turn is blocked: exactly one warning chunk and no model response.
		const chunks = textChunks(fixture, sessionId)
		expect(chunks).toHaveLength(1)
		const warning = chunks[0]
		expect(warning.text).toContain("text-only-model does not accept image input")
		expect(warning.text).toContain("switch to a model with image support or remove the image and resend")
		// The warning keeps its own message-id namespace plus a blank-line
		// separator, so it renders as its own paragraph.
		expect(warning.messageId).toMatch(/^km\./)
		expect(warning.text.endsWith("\n\n")).toBe(true)

		// Nothing reached the backend — no model turn was spent on the blocked
		// prompt. (The fake server still sees the harness's own identity/
		// telemetry traffic, so assert specifically on chat completions.)
		expect(chatBodies(fixture)).toHaveLength(0)
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

		// No refusal message — the image went through.
		const chunks = textChunks(fixture, sessionId)
		expect(chunks.some((chunk) => chunk.text.includes("does not accept image input"))).toBe(false)
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
