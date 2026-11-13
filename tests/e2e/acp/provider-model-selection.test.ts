import { afterEach, describe, expect, it } from "vitest"
import { PROVIDER_CATALOG } from "../tui/support/provider-catalog.js"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

describe("ACP gateway provider selection", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it("distinguishes providers and keeps their route and thinking settings through a tool round trip", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-provider-model-selection",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "shared",
			extraArgs: ["--model", "kimchi-dev/shared"],
			settings: { defaultThinkingLevel: "high" },
			models: PROVIDER_CATALOG,
			responses: [
				{ toolCalls: [{ function: { name: "list_models", arguments: "{}" } }] },
				{ stream: ["Upstream ", "round trip."] },
				{ stream: ["Auto routed."], responseModel: "shared" },
			],
		})
		const session = await fixture.conn.newSession({ cwd: fixture.workDir, mcpServers: [] })
		expect(session.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "model",
					currentValue: "kimchi-dev/shared",
					options: expect.arrayContaining([
						{ value: "kimchi-dev/shared", name: "Shared Model (kimchi-dev)" },
						{ value: "kimchi-dev/upstream/shared", name: "Shared Model (kimchi-dev/upstream)" },
						{ value: "kimchi-dev/upstream/plain", name: "Plain Model" },
					]),
				}),
			]),
		)
		const selected = await fixture.conn.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "kimchi-dev/upstream/shared",
		})
		expect(selected.configOptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "model", currentValue: "kimchi-dev/upstream/shared" })]),
		)
		const result = await prompt(fixture, session.sessionId, "List the models")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Upstream round trip.")

		const upstreamRequests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
		expect(upstreamRequests).toHaveLength(2)
		for (const request of upstreamRequests) {
			expect(request.headers.authorization).toBe("Bearer fake")
			expect(request.headers["x-provider-type"]).toBe("upstream")
			expect(request.body).toMatchObject({ model: "shared" })
			expect(request.body).not.toHaveProperty("reasoning_effort")
		}
		expect(upstreamRequests[1]?.body).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "tool", content: expect.stringContaining("kimchi-dev/upstream/shared") }),
			]),
		})
		expect(fixture.client.sessionUpdates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					update: expect.objectContaining({
						sessionUpdate: "agent_message_chunk",
						_meta: {
							"kimchi.dev": {
								modelId: "kimchi-dev/upstream/shared",
								requestedModelId: "kimchi-dev/upstream/shared",
							},
						},
					}),
				}),
			]),
		)

		await fixture.conn.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: "kimchi-dev/auto",
		})
		const routed = await prompt(fixture, session.sessionId, "Use Auto")
		expect(routed.stopReason).toBe("end_turn")
		expect(routed.chunks).toContain("Auto routed.")
		const autoRequest = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions")).at(-1)
		expect(autoRequest?.body).toMatchObject({ model: "auto" })
		expect(autoRequest?.headers.authorization).toBe("Bearer fake")
		expect(autoRequest?.headers).not.toHaveProperty("x-provider-type")
		expect(autoRequest?.headers).not.toHaveProperty("x-provider-name")
	})
})
