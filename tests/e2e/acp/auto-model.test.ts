import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

const MODELS = [
	{
		slug: "routed",
		displayName: "Fake Routed",
		provider: "ai-enabler",
		input: ["text"] as const,
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]

const ROUTED_ROUTER_RESPONSE = { best_model: "routed", probabilities: { routed: 1 } }

describe("ACP Auto model", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("keeps a saved Auto model working and visible without the experimental flag", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-saved-default",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["ACP Auto works."] }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/auto")
		expect(session.models?.availableModels.map((model) => model.modelId)).toContain("kimchi-dev/auto")

		const result = await prompt(fixture, session.sessionId, "Use the saved Auto model")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP Auto works.")
		expect(fixture.fake.requests.filter((request) => request.url.startsWith("/v1/route"))).toHaveLength(1)
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		expect(chat[0]?.body).toMatchObject({ model: "routed" })
	})

	it("starts each new session in Auto after a concrete model selection", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-default",
			providerId: "kimchi-dev",
			defaultModel: false,
			models: MODELS,
			responses: [],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/auto")
		expect(session.models?.availableModels.map((model) => model.modelId)).toContain("kimchi-dev/auto")

		await fixture.conn.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "kimchi-dev/routed" })
		const nextSession = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(nextSession.models?.currentModelId).toBe("kimchi-dev/auto")
	})
})
