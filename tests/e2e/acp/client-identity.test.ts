// ACP integration: the client's initialize `clientInfo` (name/version from
// the IDE/CLI driving the agent) must reach the LLM provider request as the
// `X-Acp-Client-Name` header, so the recording proxy can attribute
// chat_completions rows to the consuming client. Every proxied LLM request
// of the session carries it; without an ACP client the header is absent.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const CLIENT_INFO = { name: "test-verify", version: "1.2.3" }

describe("ACP integration — client identity header", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "client-identity",
			responses: [{ stream: ["hello from the fake model."] }],
			clientInfo: CLIENT_INFO,
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("stamps X-Acp-Client-Name from the initialize clientInfo on every proxied LLM request", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await prompt(fixture, sessionId, "Say hi in one word")

		// Main LLM requests only — the background session-naming request hits a
		// different path and intentionally carries no client headers.
		const chatRequests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
		expect(chatRequests.length).toBeGreaterThan(0)
		for (const request of chatRequests) {
			expect(request.headers["x-acp-client-name"]).toBe(CLIENT_INFO.name)
		}
	})
})
