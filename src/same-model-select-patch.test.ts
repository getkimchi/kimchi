import { AgentSession, ModelSelectorComponent } from "@earendil-works/pi-coding-agent"
import { expect, it, vi } from "vitest"
import { applySameModelSelectPatch } from "./same-model-select-patch.js"

const model = {
	id: "thinker",
	name: "Thinker",
	provider: "fake",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_000,
} as const

function createSession() {
	const emit = vi.fn().mockResolvedValue(undefined)
	const session = {
		model,
		agent: { state: { model } },
		_modelRuntime: { checkAuth: vi.fn().mockResolvedValue(true) },
		_getThinkingLevelForModelSwitch: vi.fn().mockReturnValue("high"),
		setThinkingLevel: vi.fn(),
		sessionManager: { appendModelChange: vi.fn() },
		settingsManager: { setDefaultModelAndProvider: vi.fn() },
		_extensionRunner: { emit },
		// biome-ignore lint/suspicious/noExplicitAny: focused fake delegates to Pi's private hook
		_emitModelSelect: (AgentSession.prototype as any)._emitModelSelect,
	}
	return { emit, session }
}

it("emits model_select when the user reselects the active model in the model menu", async () => {
	const { emit, session } = createSession()
	// biome-ignore lint/suspicious/noExplicitAny: invoking patched upstream methods on focused fakes
	const setModel = (AgentSession.prototype as any).setModel
	// biome-ignore lint/suspicious/noExplicitAny: invoking patched upstream methods on focused fakes
	const handleSelect = (ModelSelectorComponent.prototype as any).handleSelect
	let selection: Promise<void> | undefined
	const selector = {
		dispose: vi.fn(),
		filteredModels: [{ model }],
		selectedIndex: 0,
		sessionId: "session-1",
		settingsManager: { setDefaultModelAndProvider: vi.fn() },
		onSelectCallback: (selectedModel: typeof model) => {
			selection = setModel.call(session, selectedModel)
			return selection
		},
	}

	handleSelect.call(selector, model)
	await selection

	expect(emit).toHaveBeenCalledWith({
		type: "model_select",
		model,
		previousModel: model,
		source: "set",
	})
})

it("does not emit model_select when a programmatic call reselects the active model", async () => {
	const { emit, session } = createSession()
	// biome-ignore lint/suspicious/noExplicitAny: invoking the patched upstream method on a focused fake
	const setModel = (AgentSession.prototype as any).setModel

	await setModel.call(session, model)

	expect(emit).not.toHaveBeenCalled()
})

it("does not patch when Pi's private model-selector hook is unavailable", () => {
	// biome-ignore lint/suspicious/noExplicitAny: simulating a future Pi version without the private hook
	const prototype = ModelSelectorComponent.prototype as any
	const current = prototype.handleSelect
	prototype.handleSelect = undefined

	try {
		applySameModelSelectPatch()
		expect(prototype.handleSelect).toBeUndefined()
	} finally {
		prototype.handleSelect = current
	}
})
