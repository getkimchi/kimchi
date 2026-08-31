import type { Model } from "@earendil-works/pi-ai"
import type {
	BeforeAgentStartEvent,
	ExtensionEvent,
	InputEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearAutoRoutingAttempt, consumeAutoRoutingAttempt } from "./api-provider.js"
import autoModelExtension, { createAutoModelExtension } from "./index.js"
import { ROUTER_IMAGE_METADATA } from "./router-query.js"
import {
	AUTO_RESOLUTION_ENTRY,
	clearAutoRoutingState,
	getAutoRoutingState,
	resolvedEntry,
	setAutoRoutingState,
} from "./state.js"

const SESSION_ID = "auto-session"
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>

function model(id: string, input: ("text" | "image")[] = ["text"], reasoning = true): Model<string> {
	return {
		id,
		name: id,
		api: id === "auto" ? "kimchi-auto" : "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function harness(target = model("kimi-k2.5", ["text", "image"]), requiresVision = false) {
	const extension = createExtensionApi()
	if (requiresVision) createAutoModelExtension({ requiresVision })(extension.api)
	else autoModelExtension(extension.api)
	const ctx = createContext({
		model: model("auto", ["text", "image"]),
		sessionManager: { getSessionId: () => SESSION_ID, getBranch: () => [], getEntries: () => [] },
		modelRegistry: {
			getAvailable: () => [target],
			find: (provider, id) => (provider === target.provider && id === target.id ? target : undefined),
			getApiKeyForProvider: vi.fn(async () => "gateway-key"),
		},
		scopedModels: [],
	})
	return { ...extension, ctx, target }
}

function beforeEvent(overrides: Partial<BeforeAgentStartEvent> = {}): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "implement the feature",
		systemPrompt: "system",
		systemPromptOptions: {},
		...overrides,
	} as BeforeAgentStartEvent
}

function custom(data: unknown): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: AUTO_RESOLUTION_ENTRY,
		data,
	}
}

afterEach(() => {
	populateCliArgs([])
	clearAutoRoutingAttempt(SESSION_ID)
	clearAutoRoutingState(SESSION_ID)
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("Auto model extension", () => {
	it("records an explicit Auto CLI selection once through Pi's normal model path", async () => {
		populateCliArgs(["--model", "kimchi-dev/auto"])
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const auto = model("auto", ["text", "image"])
		const ctx = createContext({
			model: auto,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
			modelRegistry: { find: () => auto, getAvailable: () => [] },
		})
		const start = extension.getHandler<SessionStartEvent>("session_start")

		await start({ type: "session_start", reason: "startup" }, ctx)
		await start({ type: "session_start", reason: "reload" }, ctx)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(auto)
	})

	it("does not persist an ordinary concrete CLI selection", async () => {
		populateCliArgs(["--model", "kimi-k2.5"])
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const concrete = model("kimi-k2.5")
		const ctx = createContext({
			model: concrete,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(setModel).not.toHaveBeenCalled()
	})

	it("records an explicit concrete CLI override of a saved Auto session", async () => {
		populateCliArgs(["--model", "kimi-k2.5"])
		const target = model("kimi-k2.5")
		const entries = [custom(resolvedEntry(target))]
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const ctx = createContext({
			model: target,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => entries },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(target)
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("keeps a concrete model when the session has no Auto state", async () => {
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const getEntries = vi.fn(() => [])
		const ctx = createContext({
			model: model("kimi-k2.5"),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(getEntries).toHaveBeenCalledOnce()
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("restores the Auto selection that Pi inferred as the concrete assistant model", async () => {
		const target = model("kimi-k2.5")
		const auto = model("auto", ["text", "image"])
		const entries = [custom(resolvedEntry(target))]
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const ctx = createContext({
			model: target,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => entries },
			modelRegistry: {
				find: (provider, id) => [auto, target].find((item) => item.provider === provider && item.id === id),
				getAvailable: () => [target],
			},
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(auto)
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "resolved", model: target })
	})

	it("restores Auto with the resolved model's reasoning capability", async () => {
		const target = model("plain", ["text"], false)
		const auto = model("auto", ["text", "image"])
		const entries = [custom(resolvedEntry(target))]
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const ctx = createContext({
			model: target,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => entries },
			modelRegistry: {
				find: (provider, id) => [auto, target].find((item) => item.provider === provider && item.id === id),
				getAvailable: () => [target],
			},
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		expect(extension.setModel).toHaveBeenCalledOnce()
		expect(extension.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "auto", api: "kimchi-auto", reasoning: false, thinkingLevelMap: undefined }),
		)
	})

	it("routes once and records the concrete model without showing a notification", async () => {
		const { getHandler, appendEntry, ctx, target } = harness()
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		const routePrompt = getHandler<BeforeAgentStartEvent>("before_agent_start")
		await routePrompt(beforeEvent(), ctx)
		expect(fetch).not.toHaveBeenCalled()
		await consumeAutoRoutingAttempt(SESSION_ID)
		await routePrompt(beforeEvent({ prompt: "second prompt" }), ctx)
		await consumeAutoRoutingAttempt(SESSION_ID)

		expect(fetch).toHaveBeenCalledOnce()
		expect(appendEntry).toHaveBeenCalledOnce()
		expect(appendEntry).toHaveBeenCalledWith("kimchi_auto_resolution", {
			version: 1,
			status: "resolved",
			provider: "kimchi-dev",
			modelId: target.id,
		})
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "resolved", model: target })
	})

	it("applies the routed model's reasoning capability to the Auto session", async () => {
		const { getHandler, setModel, ctx, target } = harness(model("plain", ["text"], false))
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		await consumeAutoRoutingAttempt(SESSION_ID)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "auto", api: "kimchi-auto", reasoning: false, thinkingLevelMap: undefined }),
		)
	})

	it("uses the routed model's supported thinking levels for Auto controls", async () => {
		const target = model("reasoning")
		target.thinkingLevelMap = { off: "none", low: "low", max: null }
		const { getHandler, setModel, ctx } = harness(target)
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		await consumeAutoRoutingAttempt(SESSION_ID)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "auto",
				reasoning: true,
				thinkingLevelMap: { off: "none", low: "low", max: null },
			}),
		)
	})

	it("reports a model update failure when routed capabilities cannot be applied", async () => {
		const { getHandler, setModel, ctx, target } = harness(model("plain", ["text"], false))
		setModel.mockResolvedValue(false)
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)

		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({
			status: "failed",
			reason: "model_update_failed",
		})
	})

	it("restores resolved reasoning capabilities when Auto is selected again", async () => {
		const target = model("plain", ["text"], false)
		const auto = model("auto", ["text", "image"])
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const ctx = createContext({
			model: auto,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})
		setAutoRoutingState(SESSION_ID, { status: "resolved", model: target })

		await extension.getHandler<ModelSelectEvent>("model_select")(
			{ type: "model_select", model: auto, previousModel: target, source: "set" },
			ctx,
		)

		expect(extension.setModel).toHaveBeenCalledOnce()
		expect(extension.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: "auto", api: "kimchi-auto", reasoning: false, thinkingLevelMap: undefined }),
		)
	})

	it("does not persist a router failure and retries on the next user prompt", async () => {
		const { getHandler, appendEntry, ctx, target } = harness()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})
		vi.stubGlobal("fetch", fetchMock)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		const routePrompt = getHandler<BeforeAgentStartEvent>("before_agent_start")
		await routePrompt(beforeEvent(), ctx)
		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({ status: "failed", reason: "router_http" })
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(appendEntry).not.toHaveBeenCalled()

		await routePrompt(beforeEvent({ prompt: "retry routing" }), ctx)
		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({ status: "resolved", model: target })

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(appendEntry).toHaveBeenCalledOnce()
		expect(appendEntry).toHaveBeenCalledWith("kimchi_auto_resolution", {
			version: 1,
			status: "resolved",
			provider: "kimchi-dev",
			modelId: target.id,
		})
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "resolved", model: target })
	})

	it("does not persist cancellation and retries on the next user prompt", async () => {
		const { getHandler, appendEntry, ctx, target } = harness()
		let requestNumber = 0
		const fetchMock = vi.fn<typeof fetch>((_input, init) => {
			requestNumber += 1
			if (requestNumber === 1) {
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(new DOMException("aborted", "AbortError"))
					if (init?.signal?.aborted) abort()
					else init?.signal?.addEventListener("abort", abort, { once: true })
				})
			}
			return Promise.resolve({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			} as Response)
		})
		vi.stubGlobal("fetch", fetchMock)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		const routePrompt = getHandler<BeforeAgentStartEvent>("before_agent_start")
		await routePrompt(beforeEvent(), ctx)
		const controller = new AbortController()
		const attempt = consumeAutoRoutingAttempt(SESSION_ID, controller.signal)
		controller.abort()
		await expect(attempt).resolves.toEqual({ status: "failed", reason: "cancelled" })
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(appendEntry).not.toHaveBeenCalled()

		await routePrompt(beforeEvent({ prompt: "corrected prompt" }), ctx)
		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({ status: "resolved", model: target })

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(appendEntry).toHaveBeenCalledOnce()
		expect(appendEntry).toHaveBeenCalledWith("kimchi_auto_resolution", {
			version: 1,
			status: "resolved",
			provider: "kimchi-dev",
			modelId: target.id,
		})
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "resolved", model: target })
	})

	it("rejects an initial image when the single recommendation is text-only", async () => {
		const { getHandler, ctx, target } = harness(model("text-only"))
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(
			beforeEvent({ images: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
			ctx,
		)
		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({
			status: "failed",
			reason: "vision_required",
		})

		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(fetch).toHaveBeenCalledWith(
			expect.any(URL),
			expect.objectContaining({
				body: JSON.stringify({ query: `implement the feature\n\n${ROUTER_IMAGE_METADATA}` }),
			}),
		)
	})

	it("routes an image-only initial prompt using image metadata", async () => {
		const { getHandler, ctx, target } = harness()
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(
			beforeEvent({ prompt: "", images: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
			ctx,
		)

		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({ status: "resolved", model: target })
		expect(fetch).toHaveBeenCalledWith(
			expect.any(URL),
			expect.objectContaining({ body: JSON.stringify({ query: ROUTER_IMAGE_METADATA }) }),
		)
	})

	it("requires a vision model when configured for forwarded image paths", async () => {
		const { getHandler, ctx, target } = harness(model("text-only"), true)
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)

		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		await expect(consumeAutoRoutingAttempt(SESSION_ID)).resolves.toEqual({
			status: "failed",
			reason: "vision_required",
		})

		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("blocks later images after a text-only resolution without rerouting", async () => {
		const { getHandler, ctx, target } = harness(model("text-only"))
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ best_model: target.id, probabilities: { [target.id]: 1 } }),
			})),
		)
		await getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, ctx)
		await getHandler<BeforeAgentStartEvent>("before_agent_start")(beforeEvent(), ctx)
		await consumeAutoRoutingAttempt(SESSION_ID)

		const result = await getHandler<InputEvent>("input")(
			{
				type: "input",
				text: "look",
				images: [{ type: "image", data: "abc", mimeType: "image/png" }],
				source: "interactive",
			},
			ctx,
		)

		expect(result).toEqual({ action: "handled" })
		expect(fetch).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Auto cannot process images in this session. Select a vision model with /model, or use /strip-images for existing images.",
			"warning",
		)
	})
})
