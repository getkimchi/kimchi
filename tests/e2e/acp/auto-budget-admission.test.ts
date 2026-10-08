/**
 * E2E ACP test: image-bearing `auto` requests are admitted without an
 * automatic token budget.
 *
 * Mirrors the TUI admission workflow (`tests/e2e/tui/auto-budget-admission`):
 * the alias-budget adapter must remove the upstream-generated alias budget at
 * the provider stream boundary so the backend admits the image-bearing
 * request, on the ACP surface too.
 */

import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/** Minimal valid 1x1 PNG, matching the fixture used by the MCP e2e suites. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

function imageBlock(): acp.ContentBlock {
	return { type: "image", data: TINY_PNG, mimeType: "image/png" }
}

function chatBodies(fixture: AcpFixture): Record<string, unknown>[] {
	return fixture.fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => request.body as Record<string, unknown>)
}

describe("ACP auto budget admission", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it("admits an image-bearing auto request without an automatic token budget", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-budget-admission",
			providerId: "kimchi-dev",
			models: [
				{
					slug: "auto",
					displayName: "Auto",
					provider: "ai-enabler",
					input: ["text", "image"],
					contextWindow: 1_048_576,
					maxTokens: 512_000,
				},
			],
			responses: [{ stream: ["Image received."] }],
		})

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "describe this image", [imageBlock()])
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Image received.")

		const bodies = chatBodies(fixture)
		expect(bodies.length).toBeGreaterThanOrEqual(1)
		const imageRequest = bodies.find((body) => JSON.stringify(body).includes('"image_url"'))
		expect(imageRequest).toBeDefined()
		// The incident regression: no automatically supplied output budget on
		// the wire for the routed alias.
		expect(imageRequest?.max_completion_tokens).toBeUndefined()
		expect(imageRequest?.max_tokens).toBeUndefined()
	})
})
