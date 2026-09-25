import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ExtensionFactory,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { populateCliArgs } from "../../cli-args.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

// The Auto-default gate performs a network lookup; default it to a
// non-entitled account so existing tests never hit the network, and override
// per test in the default-install describe below.
vi.mock("./auto-default-gate.js", () => ({
	shouldDefaultToAuto: vi.fn(async () => false),
}))

// The marker lives in settings.json; keep it in memory so each test starts
// with "not yet applied" and can assert whether it was written.
const autoDefaultStubs = vi.hoisted(() => ({ applied: false }))
vi.mock(import("../../config.js"), async (importOriginal) => ({
	...(await importOriginal()),
	readAutoDefaultApplied: () => autoDefaultStubs.applied,
	writeAutoDefaultApplied: () => {
		autoDefaultStubs.applied = true
	},
}))

// The fresh-session default gate reads the persisted default model through the
// shared settings-watcher; stub it per test.
const settingsStubs = vi.hoisted(() => ({
	getDefaultModel: vi.fn<() => string | undefined>(() => undefined),
	getDefaultProvider: vi.fn<() => string | undefined>(() => undefined),
}))
vi.mock("../../settings-watcher.js", () => ({
	getSettingsManager: () => settingsStubs,
}))

import { shouldDefaultToAuto } from "./auto-default-gate.js"
import autoModelExtension, {
	_resetAutoModelNoticeCache,
	createAutoModelRoutingExtension,
	ROUTED_MODEL_RESOLUTION_ENTRY,
} from "./index.js"
import { clearAutoRoutingState, getAutoRoutingState } from "./state.js"

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

	it("unknown routed id clears a previously-resolved pick (no stale label/telemetry)", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const byId = (id: string) => ({
			find: (_p: string, mid: string) => (mid === id ? model(id, { contextWindow: 128_000 }) : undefined),
		})
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")

		// First resolve to a known model, then the backend re-routes to an
		// unknown id — the stale resolved pick must be dropped.
		onMessageEnd(
			messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }),
			ctx({ modelRegistry: byId("kimi-k3") }) as never,
		)
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", model: { id: "kimi-k3" } })

		onMessageEnd(
			messageEnd({ model: "auto-beta", responseModel: "brand-new" }),
			ctx({ modelRegistry: byId("undefined") }) as never,
		)

		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
		expect(setModel).toHaveBeenCalledTimes(1)
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(2)
	})

	it("a rejected capability sync clears the routing state (no stale descriptor)", async () => {
		const { getHandler, setModel } = setup()
		const target = model("kimi-k3", { contextWindow: 128_000 })
		const c = ctx({ modelRegistry: { find: () => target } })
		setModel.mockRejectedValueOnce(new Error("boom"))

		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)
		await new Promise((resolve) => setTimeout(resolve, 0))

		// The fire-and-forget sync rejected; state degrades to unresolved rather
		// than crashing or leaving a stale resolved pick.
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("model_select to a different model resets the dedup but keeps the resolved pick", () => {
		const { getHandler, getAppendedEntries, setModel } = setup()
		const c = ctx({ modelRegistry: { find: () => model("kimi-k3", { contextWindow: 128_000 }) } })
		const onMessageEnd = getHandler<MessageEndEvent>("message_end")
		const onModelSelect = getHandler<"model_select">("model_select")

		onMessageEnd(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", model: { id: "kimi-k3" } })
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(1)

		// User switches away from auto-beta. The resolved pick is KEPT so
		// feedback's model_select handler can detect (via isRoutedModel) that a
		// routed virtual model was abandoned, but the dedup is reset so a later
		// re-selection re-runs the capability sync.
		onModelSelect(
			{ type: "model_select", model: model("glm-5.3"), previousModel: model("auto-beta") } as never,
			c as never,
		)
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", model: { id: "kimi-k3" } })

		// Re-selecting auto-beta resets the per-session dedup, so the same pick
		// re-syncs capabilities and re-appends the notice.
		onMessageEnd(messageEnd({ model: "auto-beta", responseModel: "kimi-k3" }), c as never)
		expect(getAutoRoutingState(SESSION_ID)).toMatchObject({ status: "resolved", model: { id: "kimi-k3" } })
		expect(getAppendedEntries(ROUTED_MODEL_RESOLUTION_ENTRY)).toHaveLength(2)
		expect(setModel).toHaveBeenCalledTimes(2) // re-synced after the switch
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

	it("leaves concrete responses passthrough (no routing state)", () => {
		// A concrete kimchi-dev response (no responseModel) leaves routing state
		// unresolved.
		const { getHandler } = setup()
		const c = ctx({ modelRegistry: { find: () => model("kimi-k3") } })
		getHandler<MessageEndEvent>("message_end")(messageEnd({ model: "kimi-k3" }), c as never)
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})
})

describe("createAutoModelRoutingExtension", () => {
	it("is idempotent and the default export is wired", () => {
		expect(() => createAutoModelRoutingExtension()).not.toThrow()
		expect(autoModelExtension).toBeDefined()
	})
})

describe("catalog-driven Auto default (main session)", () => {
	beforeEach(() => {
		vi.mocked(shouldDefaultToAuto).mockClear()
		vi.mocked(shouldDefaultToAuto).mockResolvedValue(true)
		autoDefaultStubs.applied = false
		settingsStubs.getDefaultModel.mockReturnValue(undefined)
	})

	function auto(): Model<Api> {
		return model("auto", { name: "Auto" })
	}

	function runSessionStart(extension: ExtensionFactory, ctxOverride: Parameters<typeof createContext>[0] = {}) {
		const { api, getHandler, setModel } = createExtensionApi()
		extension(api)
		const c = createContext({
			model: model("kimi-k2.6"),
			modelRegistry: { find: () => auto() },
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
			...ctxOverride,
		})
		return {
			setModel,
			start: () => getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c),
		}
	}

	it("installs Auto as the default for an entitled account when the catalog advertises it", async () => {
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k2.6")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).toHaveBeenCalledWith(auto(), { persist: true })
		expect(autoDefaultStubs.applied).toBe(true)
	})

	it("notifies on the install", async () => {
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k2.6")
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			model: model("kimi-k2.6"),
			modelRegistry: { find: () => auto() },
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(c.ui.notify).toHaveBeenCalledWith("Auto is now the default model.", "info")
	})

	it("leaves a switched-away install alone once the default has been applied", async () => {
		autoDefaultStubs.applied = true
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k2.6")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).not.toHaveBeenCalled()
	})

	it("treats a persisted Auto default as restorable, not a fresh install", async () => {
		settingsStubs.getDefaultModel.mockReturnValue("auto")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).toHaveBeenCalledWith(auto(), { persist: true })
	})

	it.each([
		"startup",
		"new",
	] as const)("leaves a fresh %s session on its existing model for a non-entitled account", async () => {
		vi.mocked(shouldDefaultToAuto).mockResolvedValue(false)
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).not.toHaveBeenCalled()
	})

	it("does not install when the catalog does not advertise auto", async () => {
		const { setModel, start } = runSessionStart(autoModelExtension, {
			modelRegistry: { find: () => undefined },
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
		expect(autoDefaultStubs.applied).toBe(false)
	})

	it("does not consult the gate when the launch choice is explicit", async () => {
		populateCliArgs(["--model", "concrete"])
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(shouldDefaultToAuto).not.toHaveBeenCalled()
		expect(setModel).not.toHaveBeenCalled()
	})
})

describe("main-session CLI model selection", () => {
	beforeEach(() => {
		autoDefaultStubs.applied = false
	})

	it("records an explicit Auto CLI selection once through Pi's normal model path", async () => {
		populateCliArgs(["--model", "kimchi-dev/auto"])
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const autoModel = model("auto", { name: "Auto" })
		const c = createContext({
			model: autoModel,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
			modelRegistry: { find: () => autoModel },
		})
		const start = extension.getHandler<SessionStartEvent>("session_start")

		await start({ type: "session_start", reason: "startup" }, c)
		await start({ type: "session_start", reason: "reload" }, c)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(autoModel, { persist: true })
	})

	it("does not persist an ordinary concrete CLI selection", async () => {
		populateCliArgs(["--model", "kimi-k2.5"])
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const c = createContext({
			model: model("kimi-k2.5"),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(setModel).not.toHaveBeenCalled()
	})

	it("records an explicit concrete CLI override of a saved Auto session", async () => {
		populateCliArgs(["--model", "kimi-k2.5"])
		const target = model("kimi-k2.5")
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const entries: SessionEntry[] = [
			{
				type: "model_change",
				id: crypto.randomUUID(),
				parentId: null,
				timestamp: new Date().toISOString(),
				provider: "kimchi-dev",
				modelId: "auto",
			},
		]
		const c = createContext({
			model: target,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => entries },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(target, { persist: true })
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("records an explicit concrete CLI override of a saved Auto default on fresh startup", async () => {
		// Fresh startup: no session entries yet and ctx.model is already the CLI
		// choice, so the saved default itself is what makes this an override of
		// Auto — and it must persist.
		populateCliArgs(["--model", "kimi-k2.5"])
		settingsStubs.getDefaultModel.mockReturnValue("auto")
		settingsStubs.getDefaultProvider.mockReturnValue("kimchi-dev")
		const target = model("kimi-k2.5")
		const extension = createExtensionApi()
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		autoModelExtension(extension.api)
		const c = createContext({
			model: target,
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(target, { persist: true })
		expect(getAutoRoutingState(SESSION_ID)).toEqual({ status: "unresolved" })
	})

	it("leaves child model selection to the agent runner", async () => {
		const extension = createExtensionApi()
		createAutoModelRoutingExtension()(extension.api)
		const setModel = vi.fn(async () => true)
		Object.assign(extension.api, { setModel })
		const c = createContext({
			model: model("kimi-k2.5"),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(setModel).not.toHaveBeenCalled()
	})
})
