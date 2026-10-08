import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type {
	ExtensionFactory,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MULTI_MODEL_ID, populateCliArgs } from "../../cli-args.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

// The retired-marker cleanup reads settings.json under the real agent config
// dir; point it at a per-test temp dir so tests never touch the developer's
// own settings.json. settingsPath additionally backs the file-backed
// read/writeConfigSetting stubs below.
const configStubs = vi.hoisted(() => ({ agentConfigDir: "", settingsPath: "" }))
vi.mock(import("../../config.js"), async (importOriginal) => ({
	...(await importOriginal()),
	getAgentConfigDir: () => configStubs.agentConfigDir,
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

// The gated-org overwrite writes the developer's real settings.json in
// production — HARNESS_SETTINGS_PATH is baked from homedir() at module load,
// so the path itself cannot be redirected in-process. Back the stubs with the
// per-test temp settings.json instead: reads and writes hit real JSON on disk
// through the production helpers (readJson/writeJson/getConfigSetting), so
// tests observe the actual file transition instead of recorded mock calls.
// Only the redundant-write skip (config[key] === value) is re-implemented.
const settingsFileStubs = vi.hoisted(() => ({
	readConfigSetting: vi.fn(),
	writeConfigSetting: vi.fn(),
}))
vi.mock(import("../../config/settings.js"), async (importOriginal) => {
	const actual = await importOriginal()
	const { readJson, writeJson } = await import("../../config/json.js")
	settingsFileStubs.readConfigSetting.mockImplementation(
		<T>(key: string, satisfies: (value: unknown) => value is T, fallback?: T): T | undefined => {
			try {
				return actual.getConfigSetting(readJson(configStubs.settingsPath), key, satisfies, fallback)
			} catch {
				// Malformed temp file: same fallback as production.
				return fallback ?? undefined
			}
		},
	)
	settingsFileStubs.writeConfigSetting.mockImplementation((key: string, value: unknown) => {
		const config = readJson(configStubs.settingsPath)
		// Mirror the production skip: never rewrite an unchanged value.
		if (config[key] === value) return
		config[key] = value
		writeJson(configStubs.settingsPath, config)
	})
	return {
		...actual,
		readConfigSetting: settingsFileStubs.readConfigSetting,
		writeConfigSetting: settingsFileStubs.writeConfigSetting,
	}
})

import { getProcessMultiModelEnabled, setProcessMultiModelEnabled } from "../kimchi-process.js"
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

let tempDir: string

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kimchi-auto-model-test-"))
	configStubs.agentConfigDir = tempDir
	configStubs.settingsPath = join(tempDir, "settings.json")
})

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true })
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
		settingsStubs.getDefaultModel.mockReturnValue(undefined)
		settingsStubs.getDefaultProvider.mockReturnValue(undefined)
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

	it("installs Auto as the default when the catalog advertises it", async () => {
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k2.6")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).toHaveBeenCalledWith(auto(), { persist: true })
	})

	it("does not notify when the fresh session already comes up on Auto", async () => {
		// Auto is always the default now, so a fresh session starting on Auto
		// must be silent — the notice is only for switching away from another
		// model at startup.
		settingsStubs.getDefaultModel.mockReturnValue("auto")
		settingsStubs.getDefaultProvider.mockReturnValue("kimchi-dev")
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			model: auto(),
			modelRegistry: { find: () => auto() },
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(extension.setModel).not.toHaveBeenCalled()
		expect(c.ui.notify).not.toHaveBeenCalledWith(
			"New sessions start on Auto (the default). To pick a different model for this session, use your client's model selector (/model in the terminal).",
			"info",
		)
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

		expect(c.ui.notify).toHaveBeenCalledWith(
			"New sessions start on Auto (the default). To pick a different model for this session, use your client's model selector (/model in the terminal).",
			"info",
		)
	})

	it("rolls a switched-away model back to Auto on the next fresh session", async () => {
		// Auto was installed, the user deliberately switched to a concrete model,
		// and that switch persisted as the saved default. The next fresh session
		// still comes up on Auto — for entitled accounts Auto is the default,
		// not a one-time install.
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k2.6")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).toHaveBeenCalledWith(auto(), { persist: true })
	})

	it("restores Auto when the current model drifted from the saved Auto default", async () => {
		settingsStubs.getDefaultModel.mockReturnValue("auto")
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).toHaveBeenCalledWith(auto(), { persist: true })
	})

	it("drops the retired autoDefaultApplied marker from settings.json", async () => {
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ theme: "x", autoDefaultApplied: true }))
		const { start } = runSessionStart(autoModelExtension)

		await start()

		expect(JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"))).toEqual({ theme: "x" })
	})

	it("leaves settings.json untouched when the retired marker is absent", async () => {
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ theme: "x" }))
		const { start } = runSessionStart(autoModelExtension)

		await start()

		expect(JSON.parse(readFileSync(join(tempDir, "settings.json"), "utf-8"))).toEqual({ theme: "x" })
	})

	it("rolls a session on another provider's model (e.g. Claude) back to Auto", async () => {
		// The rollback is provider-agnostic: a manual switch to a model on a
		// different provider still ends at Auto on the next fresh session.
		settingsStubs.getDefaultModel.mockReturnValue("claude-sonnet-4-5")
		settingsStubs.getDefaultProvider.mockReturnValue("anthropic")
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			model: model("claude-sonnet-4-5", { provider: "anthropic" }),
			modelRegistry: { find: () => auto() },
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(extension.setModel).toHaveBeenCalledWith(auto(), { persist: true })
		expect(c.ui.notify).toHaveBeenCalledWith(
			"New sessions start on Auto (the default). To pick a different model for this session, use your client's model selector (/model in the terminal).",
			"info",
		)
	})

	it("does not install when the catalog does not advertise auto", async () => {
		const { setModel, start } = runSessionStart(autoModelExtension, {
			modelRegistry: { find: () => undefined },
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
	})

	it("leaves the model alone when the launch choice is explicit", async () => {
		populateCliArgs(["--model", "concrete"])
		const { setModel, start } = runSessionStart(autoModelExtension)

		await start()

		expect(setModel).not.toHaveBeenCalled()
	})
})

describe("catalog-driven gated default — orgs without auto", () => {
	const DEEPSEEK = "deepseek-v4-flash"

	beforeEach(() => {
		populateCliArgs([])
		settingsStubs.getDefaultModel.mockReturnValue(undefined)
		settingsStubs.getDefaultProvider.mockReturnValue(undefined)
		settingsFileStubs.writeConfigSetting.mockClear()
		settingsFileStubs.readConfigSetting.mockClear()
		// Pre-branch cohort: settings.json carries multiModel=true (the seeded
		// factory default), so the gated migration is still owed. Greenfield
		// scenarios remove the file per test.
		seedSettings({ multiModel: true })
	})

	function seedSettings(settings: Record<string, unknown>) {
		writeFileSync(configStubs.settingsPath, JSON.stringify(settings))
	}

	function readSettings(): Record<string, unknown> {
		return JSON.parse(readFileSync(configStubs.settingsPath, "utf-8"))
	}

	/** Registry serving exactly the given kimchi-dev ids (no `auto` unless listed). */
	function registryServing(ids: string[]) {
		const served = ids.map((id) => model(id, { name: `Model ${id}` }))
		return {
			find: (_p: string, mid: string) => served.find((m) => m.id === mid),
			getAvailable: () => served,
		}
	}

	function runSessionStart(ctxOverride: Parameters<typeof createContext>[0] = {}) {
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			model: model("kimi-k3"),
			modelRegistry: registryServing([DEEPSEEK]),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
			...ctxOverride,
		})
		return {
			...extension,
			ctx: c,
			start: () =>
				extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c),
		}
	}

	it("installs the served flash model as the persisted default and disables multi-model", async () => {
		// Pre-state: the session comes up multi-model-enabled (the seeded
		// global default) — the assertions below must be the outcome of
		// start(), not residual state.
		setProcessMultiModelEnabled(SESSION_ID, true)
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, ctx, start } = runSessionStart()

		await start()

		expect(setModel).toHaveBeenCalledWith(model(DEEPSEEK, { name: `Model ${DEEPSEEK}` }), { persist: true })
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`New sessions start on Model ${DEEPSEEK} (the default). To pick a different model for this session, use your client's model selector (/model in the terminal).`,
			"info",
		)
	})

	it("overwrites settings.json multiModel to false for gated organizations", async () => {
		// Pre-state: a real settings.json on disk carrying multiModel=true
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { start } = runSessionStart()

		await start()

		// Exactly one write in the whole start() run, and the file on disk
		// really transitioned — nothing outside the gated-overwrite block
		// could have driven multiModel to false. (The negative-control tests
		// in this suite pin that non-gated start() paths never write at all.)
		expect(settingsFileStubs.writeConfigSetting).toHaveBeenCalledTimes(1)
		expect(settingsFileStubs.writeConfigSetting).toHaveBeenCalledWith("multiModel", false)
		expect(readSettings()).toMatchObject({ multiModel: false })
	})

	it("still installs the gated default when the settings.json write fails", async () => {
		// readJson throws on a corrupt settings.json and writeJson on a
		// read-only one; the bookkeeping overwrite must never take down
		// session start.
		expect(readSettings()).toMatchObject({ multiModel: true })
		settingsFileStubs.writeConfigSetting.mockImplementationOnce(() => {
			throw new Error("read-only settings.json")
		})
		const { setModel, start } = runSessionStart()

		await start()

		expect(setModel).toHaveBeenCalledWith(model(DEEPSEEK, { name: `Model ${DEEPSEEK}` }), { persist: true })
	})

	it("installs the gated default on a first run with no current model", async () => {
		// Greenfield gated org: no persisted default and NO settings.json at
		// all — the seeded-default overwrite runs below, so something must be
		// installed on top of it or the user ends up on nothing.
		rmSync(configStubs.settingsPath, { force: true })
		expect(existsSync(configStubs.settingsPath)).toBe(false)
		setProcessMultiModelEnabled(SESSION_ID, true)
		const { setModel, start } = runSessionStart({ model: undefined })

		await start()

		expect(setModel).toHaveBeenCalledWith(model(DEEPSEEK, { name: `Model ${DEEPSEEK}` }), { persist: true })
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
		expect(readSettings()).toMatchObject({ multiModel: false })
	})

	it("falls back to deepseek-v4-flash-0731 when the canonical slug is unserved", async () => {
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["deepseek-v4-flash-0731"]),
		})

		await start()

		expect(setModel).toHaveBeenCalledWith(model("deepseek-v4-flash-0731", { name: "Model deepseek-v4-flash-0731" }), {
			persist: true,
		})
	})

	it("is a silent no-op when the fresh session already comes up on the gated default", async () => {
		const { setModel, ctx, start } = runSessionStart({
			model: model(DEEPSEEK),
		})

		// Pre-state: the session came up multi-model-enabled and settings.json
		// still carries multiModel=true, so the disabled state asserted below
		// is provably the outcome of start().
		setProcessMultiModelEnabled(SESSION_ID, true)
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(true)
		expect(readSettings()).toMatchObject({ multiModel: true })

		await start()

		expect(setModel).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		// The seeded-default overwrite still applies; multi-model is off either way.
		expect(settingsFileStubs.writeConfigSetting).toHaveBeenCalledWith("multiModel", false)
		expect(readSettings()).toMatchObject({ multiModel: false })
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
	})

	it("does not gate organizations that the catalog serves auto to", async () => {
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["auto", DEEPSEEK]),
		})

		await start()

		expect(settingsFileStubs.writeConfigSetting).not.toHaveBeenCalled()
		// On disk the seed is untouched: entitled orgs keep their multi-model flag.
		expect(readSettings()).toMatchObject({ multiModel: true })
		// Pre-existing behaviour: fresh sessions roll back to Auto.
		expect(setModel).toHaveBeenCalledWith(model("auto", { name: "Model auto" }), { persist: true })
	})

	it("leaves multi-model alone when neither auto nor a flash candidate is served", async () => {
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["kimi-k3"]),
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
		expect(settingsFileStubs.writeConfigSetting).not.toHaveBeenCalled()
		// On disk the seeded settings.json is untouched.
		expect(readSettings()).toMatchObject({ multiModel: true })
	})

	it("respects a deliberate default after the migration — no rollback, no notice", async () => {
		// Post-migration state: the seed wrote multiModel=false and the user
		// deliberately switched their default to kimi-k3 afterwards. The gated
		// default is a one-time migration of the multi-model default, not an
		// ever-re-forced default — only Auto rolls back on fresh sessions.
		settingsStubs.getDefaultProvider.mockReturnValue("kimchi-dev")
		settingsStubs.getDefaultModel.mockReturnValue("kimi-k3")
		seedSettings({ multiModel: false })
		expect(readSettings()).toMatchObject({ multiModel: false })
		// The registry serves the deliberate default too — otherwise the heal
		// would (correctly) re-derive it as a dead pointer.
		const { setModel, ctx, start } = runSessionStart({
			modelRegistry: registryServing([DEEPSEEK, "kimi-k3"]),
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		// The completed-migration overwrite was a redundant write: the value
		// was already false, so the file is unchanged.
		expect(readSettings()).toMatchObject({ multiModel: false })
	})

	it("migrates a user whose saved default came up as multi-model (multiModel still true)", async () => {
		// Pre-branch cohort: a concrete defaultModel was persisted (e.g. by
		// login) but multiModel stayed at the factory default (seeded in
		// beforeEach), so the session defaulted into multi-model. These are
		// the users the migration is for.
		settingsStubs.getDefaultProvider.mockReturnValue("kimchi-dev")
		settingsStubs.getDefaultModel.mockReturnValue("routine")
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, start } = runSessionStart()

		await start()

		expect(setModel).toHaveBeenCalledWith(model(DEEPSEEK, { name: `Model ${DEEPSEEK}` }), { persist: true })
	})

	it("respects an explicit --multi-model launch choice in a gated org", async () => {
		populateCliArgs(["--multi-model"])
		// Pre-state: the beforeEach seed carries multiModel=true, so the seed
		// overwrite below is a real transition caused by start().
		expect(readSettings()).toMatchObject({ multiModel: true })
		const { setModel, start } = runSessionStart()

		await start()

		// Session-level choice wins: no install. The seeded default is still
		// overwritten — it is not a user choice.
		expect(setModel).not.toHaveBeenCalled()
		expect(settingsFileStubs.writeConfigSetting).toHaveBeenCalledWith("multiModel", false)
		expect(readSettings()).toMatchObject({ multiModel: false })
	})
})

describe("self-heal — persisted default no longer served", () => {
	const DEAD = "deepseek-v4-flash"

	function seedSettings(settings: Record<string, unknown>) {
		writeFileSync(configStubs.settingsPath, JSON.stringify(settings))
	}

	function readSettings(): Record<string, unknown> {
		return JSON.parse(readFileSync(configStubs.settingsPath, "utf-8"))
	}

	function registryServing(ids: string[]) {
		const served = ids.map((id) => model(id, { name: `Model ${id}` }))
		return {
			find: (_p: string, mid: string) => served.find((m) => m.id === mid),
			getAvailable: () => served,
		}
	}

	/** Seed the deprecation sidecar read by the metadata-successor tier. */
	function seedDeprecations(entries: Record<string, unknown>) {
		writeFileSync(join(configStubs.agentConfigDir, "model-deprecations.json"), JSON.stringify(entries))
	}

	function runSessionStart(ctxOverride: Parameters<typeof createContext>[0] = {}) {
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			// Upstream's findInitialModel already landed the session on some
			// fallback model; ctx.model is never the dead default here.
			model: model("kimi-k3"),
			modelRegistry: registryServing(["deepseek-v4-flash-0731"]),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
			...ctxOverride,
		})
		return {
			...extension,
			ctx: c,
			start: () =>
				extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c),
		}
	}

	beforeEach(() => {
		populateCliArgs([])
		// The completed gated migration: a dead default with multiModel=false.
		// gatedDefaultOwed evaluates false here, so without the heal the one-time
		// migration branch would early-return and the dead default would survive.
		settingsStubs.getDefaultProvider.mockReturnValue("kimchi-dev")
		settingsStubs.getDefaultModel.mockReturnValue(DEAD)
		seedSettings({ multiModel: false, defaultProvider: "kimchi-dev", defaultModel: DEAD })
		// No metadata successor unless a test seeds the sidecar.
		rmSync(join(configStubs.agentConfigDir, "model-deprecations.json"), { force: true })
	})

	it("repairs a dead default to the served flash heir when auto is absent", async () => {
		const { setModel, ctx, start } = runSessionStart()

		await start()

		expect(setModel).toHaveBeenCalledWith(model("deepseek-v4-flash-0731", { name: "Model deepseek-v4-flash-0731" }), {
			persist: true,
		})
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Default model "${DEAD}" is no longer served and has been replaced. New sessions start on Model deepseek-v4-flash-0731 (the new default). To pick a different model for this session, use your client's model selector (/model in the terminal).`,
			"info",
		)
	})

	it("repairs a dead default to Auto when auto is served", async () => {
		const { setModel, ctx, start } = runSessionStart({
			modelRegistry: registryServing(["auto"]),
		})

		await start()

		expect(setModel).toHaveBeenCalledWith(model("auto", { name: "Model auto" }), { persist: true })
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Default model "${DEAD}" is no longer served and has been replaced. New sessions start on Auto (the new default). To pick a different model for this session, use your client's model selector (/model in the terminal).`,
			"info",
		)
	})

	it("heals to the metadata-declared successor over the policy heirs", async () => {
		seedDeprecations({
			[DEAD]: {
				replacement_model: "kimi-k3",
				deprecation_note: "https://kimchi.dev/deprecations/deepseek-v4-flash",
			},
		})
		const { setModel, ctx, start } = runSessionStart({
			modelRegistry: registryServing(["kimi-k3", "deepseek-v4-flash-0731"]),
		})

		await start()

		expect(setModel).toHaveBeenCalledWith(model("kimi-k3", { name: "Model kimi-k3" }), { persist: true })
		// The heal also settles multiModel=false on disk — the file-level invariant
		// holds even when the dead default predates the gated migration.
		expect(settingsFileStubs.writeConfigSetting).toHaveBeenCalledWith("multiModel", false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Default model "${DEAD}" is no longer served and has been replaced. New sessions start on Model kimi-k3 (the new default). Details: https://kimchi.dev/deprecations/deepseek-v4-flash To pick a different model for this session, use your client's model selector (/model in the terminal).`,
			"info",
		)
	})

	it("walks the declared alternatives until one is served", async () => {
		seedDeprecations({
			[DEAD]: {
				replacement_model: "gone-slug",
				alternatives: [{ slug: "also-gone" }, { slug: "kimi-k3" }],
			},
		})
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["kimi-k3", "deepseek-v4-flash-0731"]),
		})

		await start()

		expect(setModel).toHaveBeenCalledWith(model("kimi-k3", { name: "Model kimi-k3" }), { persist: true })
	})

	it("falls to the policy heir when every declared successor is unserved", async () => {
		seedDeprecations({ [DEAD]: { replacement_model: "gone-slug" } })
		const { setModel, start } = runSessionStart()

		await start()

		expect(setModel).toHaveBeenCalledWith(model("deepseek-v4-flash-0731", { name: "Model deepseek-v4-flash-0731" }), {
			persist: true,
		})
	})

	it("heals to the first served catalog model when no preferred heir exists", async () => {
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["glm-5.3", "kimi-k3"]),
		})

		await start()

		expect(setModel).toHaveBeenCalledWith(model("glm-5.3", { name: "Model glm-5.3" }), { persist: true })
	})

	it("clears the dead default without re-enabling multi-model when no catalog model is served", async () => {
		setProcessMultiModelEnabled(SESSION_ID, false)
		const { setModel, ctx, start } = runSessionStart({
			modelRegistry: registryServing([]),
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
		// The dead pointer is dropped from the file and multi-model stays
		// disabled: the heal never re-enables it — its removal is planned.
		expect(readSettings()).toEqual({ multiModel: false })
		expect(getProcessMultiModelEnabled(SESSION_ID)).toBe(false)
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			`Default model "${DEAD}" is no longer served and has been cleared. To pick a model for this session, use your client's model selector (/model in the terminal).`,
			"info",
		)
	})

	it("does not treat the multi-model sentinel default as dead — the migration owns it", async () => {
		// A persisted defaultModel of the multi-model sentinel is the factory
		// state the gated migration exists to convert, not a dead pointer; the
		// heal must leave it to the migration branch.
		settingsStubs.getDefaultModel.mockReturnValue(MULTI_MODEL_ID)
		// Factory state: the sentinel default with multiModel still enabled —
		// exactly the pre-branch cohort the gated migration converts.
		seedSettings({ multiModel: true, defaultProvider: "kimchi-dev", defaultModel: MULTI_MODEL_ID })
		setProcessMultiModelEnabled(SESSION_ID, true)
		const { setModel, ctx, start } = runSessionStart()

		await start()

		// Installed by the one-time migration, not the heal: no dead-default notice.
		expect(setModel).toHaveBeenCalledWith(model("deepseek-v4-flash-0731", { name: "Model deepseek-v4-flash-0731" }), {
			persist: true,
		})
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining(`"${DEAD}" is no longer served`), "info")
	})

	it("leaves a dead non-kimchi default to upstream's fallback", async () => {
		// Heal remedies are kimchi-dev models; a dead default from another
		// provider is not healed onto them (and never flips multiModel).
		settingsStubs.getDefaultProvider.mockReturnValue("anthropic")
		settingsStubs.getDefaultModel.mockReturnValue("claude-opus-4-8")
		seedSettings({ multiModel: false, defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" })
		const { setModel, ctx, start } = runSessionStart()

		await start()

		expect(setModel).not.toHaveBeenCalled()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		// The dead pointer stays on disk; upstream's per-launch fallback serves.
		expect(readSettings()).toMatchObject({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" })
	})

	it("does not treat a still-served default as dead", async () => {
		// The default is deliberately rotated to a sibling; the heal must leave
		// deliberate choices alone (the gated policy's no-op guard handles it).
		settingsStubs.getDefaultModel.mockReturnValue("deepseek-v4-flash-0731")
		const { setModel, start } = runSessionStart({
			modelRegistry: registryServing(["deepseek-v4-flash-0731"]),
		})

		await start()

		expect(setModel).not.toHaveBeenCalled()
	})

	it("leaves a resumed session on its restored model without healing", async () => {
		// reason "reload" is not a fresh launch: the session's model was
		// already restored (possibly via upstream's fallback) and the persisted
		// default stays untouched for the next fresh launch to handle.
		const extension = createExtensionApi()
		autoModelExtension(extension.api)
		const c = createContext({
			model: model("kimi-k3"),
			modelRegistry: registryServing(["deepseek-v4-flash-0731"]),
			sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => [] },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "reload" }, c)

		expect(extension.setModel).not.toHaveBeenCalled()
		expect(readSettings()).toMatchObject({ defaultModel: DEAD, multiModel: false })
	})
})

describe("main-session CLI model selection", () => {
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
			modelRegistry: { find: () => undefined },
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
			modelRegistry: { find: () => undefined },
		})

		await extension.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "startup" }, c)

		expect(setModel).not.toHaveBeenCalled()
	})
})
