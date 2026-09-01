import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getApiProvider,
	isRetryableAssistantError,
	type Model,
	registerApiProvider,
	streamSimple,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { clearAutoRoutingAttempt, registerAutoApiProvider, stageAutoRoutingAttempt } from "./api-provider.js"
import { AUTO_MODEL_API } from "./constants.js"
import { clearAutoRoutingState, getAutoRoutingState, setAutoRoutingState } from "./state.js"

const SESSION_ID = "provider-test-session"
const TARGET_API = "kimchi-auto-test-target"
const TARGET_SOURCE = "kimchi-auto-test-target-source"

function model(id: string, api: string, reasoning = true): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4000,
	}
}

function doneMessage(target: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "delegated" }],
		api: target.api,
		provider: target.provider,
		model: target.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

const targetStream = vi.fn((target: Model<Api>) => {
	const stream = createAssistantMessageEventStream()
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: doneMessage(target) }))
	return stream
})

beforeAll(() => {
	registerAutoApiProvider()
	registerApiProvider({ api: TARGET_API, stream: targetStream, streamSimple: targetStream }, TARGET_SOURCE)
})

afterEach(() => {
	clearAutoRoutingAttempt(SESSION_ID)
	clearAutoRoutingState(SESSION_ID)
	targetStream.mockClear()
	vi.restoreAllMocks()
})

afterAll(() => unregisterApiProviders(TARGET_SOURCE))

describe("Auto model API provider", () => {
	it("delegates with the concrete model identity and preserves request options", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		const target = model("concrete", TARGET_API)
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })

		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")
		const result = await provider
			.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID, maxTokens: 3000, reasoning: "high" })
			.result()

		expect(result).toMatchObject({ provider: "kimchi-dev", model: "concrete", api: TARGET_API })
		expect(targetStream).toHaveBeenCalledWith(
			target,
			{ messages: [] },
			expect.objectContaining({ sessionId: SESSION_ID, maxTokens: 3000, reasoning: "high" }),
		)
	})

	it("does not forward the UI-selected reasoning option to a model that cannot use it", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		const target = model("concrete", TARGET_API, false)
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })

		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")
		await provider
			.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID, maxTokens: 3000, reasoning: "low" })
			.result()

		expect(targetStream).toHaveBeenCalledWith(
			target,
			{ messages: [] },
			expect.objectContaining({ sessionId: SESSION_ID, maxTokens: 3000, reasoning: undefined }),
		)
	})

	it("returns an actionable terminal error when Auto has no usable resolution", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")

		const result = await provider.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID }).result()

		expect(result.stopReason).toBe("error")
		expect(result.errorMessage).toContain("Auto is unavailable")
		expect(result.errorMessage).toContain("retry Auto")
		expect(result.errorMessage).toContain("/model")
		expect(targetStream).not.toHaveBeenCalled()
	})

	it("stops a timed-out prompt without triggering Pi's automatic retry", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		setAutoRoutingState(SESSION_ID, { status: "attempting" })
		stageAutoRoutingAttempt(SESSION_ID, async () => ({ status: "failed", reason: "timeout" }))
		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")

		const result = await provider.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID }).result()

		expect(result.errorMessage).toContain("did not answer in time")
		expect(isRetryableAssistantError(result)).toBe(false)
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(targetStream).not.toHaveBeenCalled()
	})

	it("reports a dedicated model application failure", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		setAutoRoutingState(SESSION_ID, { status: "failed", reason: "model_update_failed" })
		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")

		const result = await provider.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID }).result()

		expect(result.errorMessage).toContain("Auto could not apply the routed model")
	})

	it("uses Pi's model-request signal to cancel a staged routing attempt", async () => {
		const auto = model("auto", AUTO_MODEL_API)
		const controller = new AbortController()
		const attempt = vi.fn(
			(signal: AbortSignal | undefined) =>
				new Promise<{ status: "failed"; reason: "cancelled" }>((resolve) => {
					expect(signal).toBe(controller.signal)
					signal?.addEventListener("abort", () => resolve({ status: "failed", reason: "cancelled" }), {
						once: true,
					})
				}),
		)
		setAutoRoutingState(SESSION_ID, { status: "attempting" })
		stageAutoRoutingAttempt(SESSION_ID, attempt)

		const provider = getApiProvider(AUTO_MODEL_API)
		if (!provider) throw new Error("Auto API provider was not registered")
		const resultPromise = provider
			.streamSimple(auto, { messages: [] }, { sessionId: SESSION_ID, signal: controller.signal })
			.result()
		controller.abort()
		const result = await resultPromise

		expect(result.stopReason).toBe("aborted")
		expect(result.errorMessage).toContain("routing was cancelled")
		expect(attempt).toHaveBeenCalledOnce()
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(targetStream).not.toHaveBeenCalled()
	})

	it("never intercepts a concrete kimchi-dev model with another model-level API", async () => {
		const concrete = model("concrete", TARGET_API)
		const autoProvider = getApiProvider(AUTO_MODEL_API)
		if (!autoProvider) throw new Error("Auto API provider was not registered")
		const autoSpy = vi.spyOn(autoProvider, "streamSimple")

		const result = await streamSimple(concrete, { messages: [] }).result()

		expect(result.model).toBe("concrete")
		expect(targetStream).toHaveBeenCalledOnce()
		expect(autoSpy).not.toHaveBeenCalled()
	})
})
