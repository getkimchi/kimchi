import type { Api, Model } from "@earendil-works/pi-ai"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearAutoRoutingState, setAutoRoutingState } from "./state.js"
import { installAutoSummarizationModelAdapter } from "./summarization-model.js"

const SESSION_ID = "auto-summary-session"

function model(id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	}
}

afterEach(() => clearAutoRoutingState(SESSION_ID))

describe("Auto summarization model adapter", () => {
	it("uses the session's resolved concrete model before Pi assigns an isolated summary request id", async () => {
		const auto = model("auto", "kimchi-auto")
		const target = model("kimi-k2.5", "openai-completions")
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })
		installAutoSummarizationModelAdapter()

		const getAuth = vi.fn(async (requestModel: Model<Api>) => ({ auth: { apiKey: "key" }, model: requestModel }))
		const session = {
			agent: { streamFunction: vi.fn() },
			sessionManager: { getSessionId: () => SESSION_ID },
			_modelRuntime: { getAuth },
		} as unknown as AgentSession
		const resolver = (
			AgentSession.prototype as unknown as {
				_getSummarizationRequestAuth(model: Model<Api>): Promise<{ model: Model<Api> }>
			}
		)._getSummarizationRequestAuth

		const result = await resolver.call(session, auto)

		expect(getAuth).toHaveBeenCalledWith(target)
		expect(result.model).toBe(target)
	})
})
