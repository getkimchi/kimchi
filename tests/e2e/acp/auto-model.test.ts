import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

// The fake backend catalog: `auto` is an ordinary entry; routing happens
// server-side and the concrete pick comes back in the response `model` field
// (`responseModel`).
const MODELS: Array<{
	slug: string
	displayName: string
	provider: string
	input: Array<"text" | "image">
	contextWindow: number
	maxTokens: number
}> = [
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
]

describe("ACP Auto model", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("keeps a saved Auto model working, described, and resolved-labelled", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-saved-default",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: MODELS,
			responses: [{ stream: ["ACP Auto works."], responseModel: "routed" }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/auto")
		expect(session.models?.availableModels.map((model) => model.modelId)).toContain("kimchi-dev/auto")
		// Auto advertises a short name plus a separate description, so clients
		// that render a two-line row (name above, description below) do not end
		// up showing the explanation as the row's title.
		expect(session.models?.availableModels.find((model) => model.modelId === "kimchi-dev/auto")).toMatchObject({
			name: "Auto",
			description: "Picks the best model for your tasks automatically.",
		})

		const result = await prompt(fixture, session.sessionId, "Use the saved Auto model")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP Auto works.")
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		// Honest attribution: the wire request names the virtual id; the backend
		// routed it server-side (responseModel carries the pick).
		expect(chat[0]?.body).toMatchObject({ model: "auto" })
		expect(fixture.fake.requests.filter((request) => request.url.startsWith("/v1/route"))).toHaveLength(0)

		// Once the backend's pick is learned, the label carries it so a client
		// showing only the selected model still reports what Auto chose.
		const configUpdates = fixture.client.sessionUpdates.filter(
			({ update }) => update.sessionUpdate === "config_option_update",
		)
		const autoNames = configUpdates.flatMap(({ update }) => {
			const modelOption = (update as { configOptions: acp.SessionConfigOption[] }).configOptions.find(
				(opt) => opt.id === "model",
			)
			if (modelOption?.type !== "select") return []
			const auto = modelOption.options.find((opt) => "value" in opt && opt.value === "kimchi-dev/auto")
			return auto && "name" in auto ? [auto.name] : []
		})
		expect(autoNames).toContain("Auto (routed)")
	})

	it("sends no model config update for a session that never resolves Auto", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-no-redundant-update",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "routed",
			models: MODELS,
			responses: [{ stream: ["Concrete model works."] }],
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		await fixture.conn.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "kimchi-dev/routed" })

		// Count only what the turn itself pushes: selecting the model above
		// legitimately emits its own update.
		const before = fixture.client.sessionUpdates.length
		const result = await prompt(fixture, session.sessionId, "Use the concrete model")
		expect(result.stopReason).toBe("end_turn")

		// Auto's label never changed, so the turn must not re-push the full
		// option list — the client already has it.
		const configUpdates = fixture.client.sessionUpdates
			.slice(before)
			.filter(({ update }) => update.sessionUpdate === "config_option_update")
		expect(configUpdates).toHaveLength(0)
	})

	it("keeps a model chosen after the rollout instead of returning to Auto", async () => {
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

		// The default install applies once per account: a model picked after it
		// must not be undone by the next session, which is what makes widening
		// the default to a larger cohort safe for accounts already reached by an
		// earlier wave.
		await fixture.conn.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "kimchi-dev/routed" })
		const nextSession = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(nextSession.models?.currentModelId).toBe("kimchi-dev/routed")
	})
})
