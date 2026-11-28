import { afterEach, describe, expect, it } from "vitest"
import { PROVIDER_CATALOG } from "../tui/support/provider-catalog.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import type { AcpFixture } from "./support/acp-fixture.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

interface SelectOption {
	value: string
	name: string
	description?: string
}

function modelConfigOption(configOptions: unknown): {
	currentValue?: string
	options?: SelectOption[]
} {
	const list = Array.isArray(configOptions) ? configOptions : []
	return (list.find((opt) => (opt as { id?: string }).id === "model") ?? {}) as {
		currentValue?: string
		options?: SelectOption[]
	}
}

describe("ACP integration — provider-qualified model selection (#1759)", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it("disambiguates duplicate model names across providers, preserves Auto/unique labels, and routes upstream turns", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-provider-model-selection",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: PROVIDER_CATALOG,
			responses: [
				{ stream: ["Auto routed hello."], responseModel: "shared" },
				{
					toolCalls: [
						{
							id: "call_upstream_bash",
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command: "printf acp-upstream-ok" }) },
						},
					],
				},
				{ stream: ["Upstream tool turn complete."] },
			],
		})

		const created = await fixture.conn.request("session/new", { cwd: fixture.workDir, mcpServers: [] })
		const initialModel = modelConfigOption(created.configOptions)
		expect(initialModel.currentValue).toBe("kimchi-dev/auto")

		const byValue = new Map((initialModel.options ?? []).map((opt) => [opt.value, opt]))
		expect(byValue.get("kimchi-dev/auto")?.name).toBe("Auto")
		expect(byValue.get("kimchi-dev/auto")?.description).toBeTruthy()
		expect(byValue.get("kimchi-dev/shared")?.name).toBe("Shared Model (kimchi-dev)")
		expect(byValue.get("kimchi-dev/upstream/shared")?.name).toBe("Shared Model (kimchi-dev/upstream)")
		expect(byValue.get("kimchi-dev/upstream/plain")?.name).toBe("Plain Model")

		const autoTurn = await prompt(fixture, created.sessionId, "Say hello using Auto.")
		expect(autoTurn.stopReason).toBe("end_turn")
		expect(autoTurn.chunks).toContain("Auto routed hello.")

		const configUpdatesAfterAuto = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === created.sessionId && u.update.sessionUpdate === "config_option_update",
		)
		const latestAfterAuto = configUpdatesAfterAuto.at(-1)?.update as { configOptions?: unknown } | undefined
		const autoOptionAfterTurn = modelConfigOption(latestAfterAuto?.configOptions).options?.find(
			(opt) => opt.value === "kimchi-dev/auto",
		)
		expect(autoOptionAfterTurn?.name).toBe("Auto (shared)")

		const switched = await fixture.conn.request("session/set_config_option", {
			sessionId: created.sessionId,
			configId: "model",
			value: "kimchi-dev/upstream/shared",
		})
		const switchedModel = modelConfigOption(switched.configOptions)
		expect(switchedModel.currentValue).toBe("kimchi-dev/upstream/shared")
		expect(switchedModel.options?.find((opt) => opt.value === "kimchi-dev/upstream/shared")?.name).toBe(
			"Shared Model (kimchi-dev/upstream)",
		)
		expect(switchedModel.options?.find((opt) => opt.value === "kimchi-dev/shared")?.name).toBe(
			"Shared Model (kimchi-dev)",
		)

		const reqCountBeforeUpstreamTurn = chatRequests(fixture).length
		const toolTurn = await prompt(fixture, created.sessionId, "Run printf acp-upstream-ok via bash.")
		expect(toolTurn.stopReason).toBe("end_turn")
		expect(toolTurn.chunks).toContain("Upstream tool turn complete.")

		const upstreamReqs = chatRequests(fixture).slice(reqCountBeforeUpstreamTurn)
		expect(upstreamReqs).toHaveLength(2)
		for (const req of upstreamReqs) {
			expect(req.headers["x-provider-type"]).toBe("upstream")
			expect(req.headers.authorization).toBe("Bearer fake")
			expect((req.body as { model?: unknown }).model).toBe("shared")
			expect((req.body as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined()
		}

		const responseChunks = fixture.client.sessionUpdates.filter(
			(u) =>
				u.sessionId === created.sessionId &&
				u.update.sessionUpdate === "agent_message_chunk" &&
				u.update.content.type === "text" &&
				u.update.content.text.includes("Upstream tool turn complete."),
		)
		expect(responseChunks).toHaveLength(1)
		expect(responseChunks[0]?.update._meta).toMatchObject({
			"kimchi.dev": { modelId: "kimchi-dev/upstream/shared" },
		})
	})

	it("further disambiguates same-provider models sharing a display name", async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-provider-model-same-provider-duplicate",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "auto",
			models: [
				...PROVIDER_CATALOG,
				{
					slug: "shared-alt",
					displayName: "Shared Model",
					provider: "upstream",
					reasoning: false,
					input: ["text"],
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
			],
			responses: [],
		})

		const created = await fixture.conn.request("session/new", { cwd: fixture.workDir, mcpServers: [] })
		const options = modelConfigOption(created.configOptions).options ?? []
		const byValue = new Map(options.map((opt) => [opt.value, opt.name]))

		expect(byValue.get("kimchi-dev/shared")).toBe("Shared Model (kimchi-dev)")
		expect(byValue.get("kimchi-dev/upstream/shared")).toBe("Shared Model (kimchi-dev/upstream/shared)")
		expect(byValue.get("kimchi-dev/upstream/shared-alt")).toBe("Shared Model (kimchi-dev/upstream/shared-alt)")
		expect(byValue.get("kimchi-dev/upstream/plain")).toBe("Plain Model")
	})
})
