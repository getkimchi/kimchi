import type * as acp from "@agentclientprotocol/sdk"
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

	it("keeps a saved Auto model working and visible without the experimental flag for an entitled account", async () => {
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
		expect(fixture.fake.requests.filter((request) => request.url.startsWith("/v1/route"))).toHaveLength(1)
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		expect(chat[0]?.body).toMatchObject({ model: "routed" })

		// Once the router resolves, the label carries the pick so a client showing
		// only the selected model still reports what Auto chose.
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

		// The rollout applies once per account: a model picked after it must not be
		// undone by the next session, which is what makes widening the rollout to a
		// larger cohort safe for accounts already reached by an earlier wave.
		await fixture.conn.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "kimchi-dev/routed" })
		const nextSession = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(nextSession.models?.currentModelId).toBe("kimchi-dev/routed")
	})

	it("leaves a new session off Auto for an external account and hides it from the model list", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-default-external",
			providerId: "kimchi-dev",
			defaultModel: false,
			models: MODELS,
			responses: [],
			userEmail: "tester@example.com",
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).not.toBe("kimchi-dev/auto")
		// Without the flag or the @cast.ai entitlement, Auto is not discoverable.
		expect(session.models?.availableModels.map((model) => model.modelId)).not.toContain("kimchi-dev/auto")
	})

	it("keeps a saved Auto model working while hidden for an external account without the flag", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-saved-default-external",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: MODELS,
			routerResponses: [ROUTED_ROUTER_RESPONSE],
			responses: [{ stream: ["ACP Auto works."] }],
			userEmail: "tester@example.com",
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/auto")
		expect(session.models?.availableModels.map((model) => model.modelId)).not.toContain("kimchi-dev/auto")

		const result = await prompt(fixture, session.sessionId, "Use the saved Auto model")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP Auto works.")
		expect(fixture.fake.requests.filter((request) => request.url.startsWith("/v1/route"))).toHaveLength(1)
		const chat = fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		expect(chat).toHaveLength(1)
		expect(chat[0]?.body).toMatchObject({ model: "routed" })
	})

	it("advertises Auto when experimental features are enabled", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-auto-visible-with-flag",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "routed",
			models: MODELS,
			responses: [],
			extraArgs: ["--enable-experimental-features"],
			userEmail: "tester@example.com",
		})

		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.models?.currentModelId).toBe("kimchi-dev/routed")
		expect(session.models?.availableModels.map((model) => model.modelId)).toContain("kimchi-dev/auto")
	})
})
