import { afterEach, describe, expect, it } from "vitest"
import type { FakeModel } from "../tui/support/fake-openai-server.js"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

const MODELS: FakeModel[] = [
	{
		slug: "truncating",
		displayName: "Truncating model",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "medium", "high"] },
	},
]

function chatRequests(fixture: AcpFixture) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

describe("ACP native length fallback", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("keeps native nudging but adds no custom continuation, notice, or effort config push", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-request-length-default-client",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "truncating",
			models: MODELS,
			responses: [{ thinking: ["Capped"], finishReason: "length" }],
		})
		const session = await fixture.conn.request("session/new", { cwd: fixture.workDir, mcpServers: [] })
		await fixture.conn.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "reasoning_effort",
			value: "high",
		})
		await prompt(fixture, session.sessionId, "Start the capped response")
		expect(chatRequests(fixture)).toHaveLength(2)
		const legacyNudge = JSON.stringify(chatRequests(fixture)[1].body)
		expect(legacyNudge).toContain("If you have finished, please summarize the result for the user")
		expect(legacyNudge).not.toContain("Your previous answer reached the output length limit")
		const updateCount = fixture.client.sessionUpdates.length
		await fixture.conn.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "reasoning_effort",
			value: "low",
		})
		expect(fixture.client.sessionUpdates.slice(updateCount)).toHaveLength(0)
		expect(
			fixture.client.extNotifications.some((notification) =>
				JSON.stringify(notification.params).includes("Queued one medium continuation"),
			),
		).toBe(false)
	})
})
