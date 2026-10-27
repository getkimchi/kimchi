import { afterEach, describe, expect, it } from "vitest"
import type { FakeModel } from "../tui/support/fake-openai-server.js"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

// Curated catalog: glm-5.3 offers low/high/max; minimax-m3 is curated-none
// (thinking exists, no distinct levels — the provider default applies). The
// metadata refresh at startup turns these into thinkingLevels + compat stamps
// in models.json, exactly like the interactive CLI path.
const MODELS: FakeModel[] = [
	{
		slug: "glm-5.3",
		displayName: "GLM 5.3",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "high", "max"] },
	},
	{
		slug: "minimax-m3",
		displayName: "MiniMax M3",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: [] },
	},
]

describe("ACP thinking-level curation", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("clamps the session's thinking level into the curated set on the first request", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-thinking-curated-clamp",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "glm-5.3",
			models: MODELS,
			responses: [{ stream: ["ACP curated works."] }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/glm-5.3")

		const result = await prompt(fixture, session.sessionId, "Say ok")
		expect(result.stopReason).toBe("end_turn")
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		// The default level (medium) is clamped upward into the curated set at
		// session creation — the shared createAgentSession seam, so ACP parity
		// holds without the interactive CLI's startup path.
		expect(chat[0]?.body).toMatchObject({ model: "glm-5.3", reasoning_effort: "high" })
	})

	it("sends no explicit effort for curated-none models", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-thinking-curated-none",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "minimax-m3",
			models: MODELS,
			responses: [{ stream: ["ACP none works."] }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/minimax-m3")

		const result = await prompt(fixture, session.sessionId, "Say ok")
		expect(result.stopReason).toBe("end_turn")
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		// Provider default: neither the stale session level nor a "none" —
		// reasoning_effort is absent from the request entirely.
		expect(chat[0]?.body).not.toHaveProperty("reasoning_effort")
	})
})
