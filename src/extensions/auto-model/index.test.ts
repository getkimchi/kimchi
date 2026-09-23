import type { Api, Model } from "@earendil-works/pi-ai"
import type { MessageEndEvent, MessageUpdateEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { clearAutoRoutingState, getAutoRoutingState } from "../router/state.js"
import autoModelExtension, {
	_resetAutoModelNoticeCache,
	createAutoModelRoutingExtension,
	ROUTED_MODEL_RESOLUTION_ENTRY,
} from "./index.js"

const SESSION_ID = "session-1"

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 16_384,
		...overrides,
	}
}

function messageEnd(message: Partial<Record<string, unknown>>): MessageEndEvent {
	return {
		type: "message_end",
		message: { role: "assistant", content: [], provider: "kimchi-dev", ...message },
	} as unknown as MessageEndEvent
}

function messageUpdate(message: Partial<Record<string, unknown>>): MessageUpdateEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [], provider: "kimchi-dev", ...message },
	} as unknown as MessageUpdateEvent
}

function routedEntry(requestedId: string, modelId: string): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: ROUTED_MODEL_RESOLUTION_ENTRY,
		data: { version: 1, requestedId, provider: "kimchi-dev", modelId },
	}
}

function setup() {
	const { api, getHandler, getAppendedEntries, setModel, getEntryRenderer } = createExtensionApi()
	autoModelExtension(api)
	return { api, getHandler, getAppendedEntries, setModel, getEntryRenderer }
}

function ctx(overrides: Parameters<typeof createContext>[0] = {}) {
	return createContext({
		model: model("auto-beta"),
		modelRegistry: { find: () => model("kimi-k3") },
		sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		...overrides,
	})
}

afterEach(() => {
	clearAutoRoutingState(SESSION_ID)
	_resetAutoModelNoticeCache()
})

describe("auto-model extension", () => {
	it("learns the pick from message_update (early, near stream-start)", () => {
		// The backend stamps chunk.model on the first streamed chunk, so the pick
		// is recognisable during `message_update` — before the turn ends.
		const { getHandler, getAppendedEntries, setModel } = setup()
		const target = model("kimi-k3", { contextWindow: 128_000 })
		const c = ctx({ modelRegistry: { find: () => target } })

		getHandler<MessageUpdateEvent>("message_update")(
			messageUpdate({ model: "auto-beta", responseModel: "kimi-k3" }),
			c as never,
		)

		expect(getAutoRoutingState(SESSION_ID)).toEqual({
			status: "resolved",
			model: target,
			requestedId: "auto-beta",
		})
		expect(setModel).toHaveBeenCalledTimes(1)
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toEqual([
			{ version: 1, requestedId: "auto-beta", provider: "kimchi-dev", modelId: "kimi-k3" },
		])
	})

	it("does not announce twice when message_update repeats the same pick", () => {
		// Guard against per-token `message_update` firing: the notice + sync must
		// run once per pick, not once per streamed token.
		const { getHandler, getAppendedEntries, setModel } = setup()
		const c = ctx({ modelRegistry: { find: () => model("kimi-k3", { contextWindow: 128_000 }) } })
		const onMessageUpdate = getHandler<MessageUpdateEvent>("message_update")

		onMessageUpdate(messageUpdate({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)
		onMessageUpdate(messageUpdate({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)

		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(1)
		expect(setModel).toHaveBeenCalledTimes(1)
	})

	it("records the routed model, syncs capabilities, and appends a pick notice", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const target = model("kimi-k3", { contextWindow: 128_000 })
		const c = ctx({ modelRegistry: { find: () => target } })

		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)

		expect(getAutoRoutingState(SESSION_ID)).toEqual({
			status: "resolved",
			model: target,
			requestedId: "auto-beta",
		})
		expect(setModel).toHaveBeenCalledTimes(1)
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toEqual([
			{ version: 1, requestedId: "auto-beta", provider: "kimchi-dev", modelId: "kimi-k3" },
		])
	})

	it("does not append a second notice when the routed model is unchanged", () => {
		const { getHandler, getAppendedEntries } = setup()
		const c = ctx({ modelRegistry: { find: () => model("kimi-k3") } })
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")

		onMessageEnd(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)
		onMessageEnd(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)

		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(1)
	})

	it("re-routes: appends a new pick and re-syncs when the backend switches targets", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const byId = (id: string) => ({
			find: (_p: string, mid: string) => (mid === id ? model(id, { contextWindow: 128_000 }) : undefined),
		})
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")

		onMessageEnd(
			messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }),
			ctx({ modelRegistry: byId("kimi-k3") }) as never,
		)
		onMessageEnd(
			messageEnd({ model: "auto-beta", responseModel: "glm-5.3-flash" }),
			ctx({ modelRegistry: byId("glm-5.3-flash") }) as never,
		)

		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(2)
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ requestedId: "auto-beta", model: { id: "glm-5.3-flash" } })
		expect(setModel).toHaveBeenCalledTimes(2)
	})

	it("unknown routed id: displays the raw id and does not sync capabilities", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const c = ctx({ modelRegistry: { find: () => undefined } })

		getHandler<MessageEndEvent>("message_end")(
			messageEnd({ model: "auto-beta", responseModel: "brand-new" }),
			c as never,
		)

		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(setModel).not.toHaveBeenCalled()
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toEqual([
			{ version: 1, requestedId: "auto-beta", provider: "kimchi-dev", modelId: "brand-new" },
		])
	})

	it("ignores non-routed responses (no responseModel or same-as-requested)", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const c = ctx({})

		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "auto-beta" }), c as never)
		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "kimi-k3", responseModel: "kimi-k3" }), c as never)

		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(0)
		expect(setModel).not.toHaveBeenCalled()
	})

	it("hydrates session_start from a persisted pick and re-applies the synced descriptor", async () => {
		const { getHandler, setModel } = setup()
		const target = model("kimi-k3", { contextWindow: 128_000 })
		const onSessionStart = getHandler<"session_start">("session_start")
		const c = ctx({
			modelRegistry: { find: () => target },
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [routedEntry("auto-beta", "kimi-k3")] },
		})

		await onSessionStart({ type: "session_start" } as never, c as never)

		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({
			status: "resolved",
			model: target,
			requestedId: "auto-beta",
		})
		expect(setModel).toHaveBeenCalledTimes(1)
	})

	it("renders the pick notice as a dim '<requested> picked <routed>.'", () => {
		const { getEntryRenderer } = setup()
		const renderer = getEntryRenderer(ROUTED_MODEL_RESOLUTION_ENTRY)
		const theme = { fg: (_name: string, value: string) => value } as never
		const rendered = renderer(
			routedEntry("auto-beta", "kimi-k3") as Parameters<typeof renderer>[0],
			{ expanded: false },
			theme,
		)
		expect(rendered?.render(120).join("\n").trimEnd()).toBe("auto-beta picked kimi-k3.")
	})

	it("does not affect v1 'auto' semantics (concrete responses passthrough)", () => {
		// Attribute-level independence: v1 writes its own state keyed by session;
		// this extension only reacts to backend-routed responseModel. A concrete
		// kimchi-dev response (no responseModel) leaves routing state unresolved.
		const { getHandler } = setup()
		const c = ctx({ modelRegistry: { find: () => model("kimi-k3") } })
		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "kimi-k3" }), c as never)
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})
})

describe("createAutoModelRoutingExtension", () => {
	it("is idempotent and the default export is wired like v1's factory outcome", () => {
		expect(() => createAutoModelRoutingExtension()).not.toThrow()
		expect(autoModelExtension).toBeDefined()
	})
})
