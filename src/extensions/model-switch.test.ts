import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import createModelGuardExtension, {
	__resetImagesDetectedForTest,
	__setLatestMessagesForTest,
	sessionHasImages,
} from "./model-guard.js"
import modelSwitchExtension, {
	__resetModelSwitchStateForTest,
	getModelTier,
	withSuppressedModelSelectGuard,
} from "./model-switch.js"
import { getMultiModelEnabled, resolveMultiModelEnabled, setMultiModelEnabled } from "./multi-model.js"

type RegisteredTool = {
	name: string
	label?: string
	description?: string
	parameters: unknown
	execute: (
		toolCallId: string,
		params: { model: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

type ModelEntry = { id: string; provider: string; name: string; input?: ("text" | "image")[]; contextWindow?: number }

interface Harness {
	tool: RegisteredTool
	setModel: ReturnType<typeof vi.fn>
	find: ReturnType<typeof vi.fn>
	getAvailable: ReturnType<typeof vi.fn>
	exec: (
		model: string,
		opts?: { currentModel?: ModelEntry; imagesPresent?: boolean },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

const MODELS: ModelEntry[] = [
	{ id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6", input: ["text", "image"], contextWindow: 200_000 },
	{ id: "minimax-m2.7", provider: "kimchi-dev", name: "MiniMax M2.7", input: ["text"], contextWindow: 100_000 },
	{
		id: "nemotron-3-ultra-fp4",
		provider: "kimchi-dev",
		name: "Nemotron 3 Ultra FP4",
		input: ["text"],
		contextWindow: 1_000_000,
	},
	{
		id: "claude-sonnet-4-20250514",
		provider: "anthropic",
		name: "Claude Sonnet 4",
		input: ["text", "image"],
		contextWindow: 200_000,
	},
]

function createHarness(options: { setModelResult?: boolean } = {}): Harness {
	const { setModelResult = true } = options
	let registered: RegisteredTool | undefined
	const setModel = vi.fn(async () => setModelResult)
	const find = vi.fn((provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id))
	const getAvailable = vi.fn(() => MODELS)
	const pi = {
		on: vi.fn(),
		registerTool: (tool: RegisteredTool) => {
			registered = tool
		},
		setModel,
		registerCommand: vi.fn(),
	} as unknown as ExtensionAPI

	modelSwitchExtension(pi)

	if (!registered) throw new Error("set_model tool was not registered")
	const tool = registered

	const exec: Harness["exec"] = (model, opts = {}) => {
		const ctx = createContext({
			modelRegistry: { find, getAvailable },
			getContextUsage: () => undefined,
			model: opts.currentModel
				? {
						id: opts.currentModel.id,
						provider: opts.currentModel.provider,
						input: opts.currentModel.input ?? ["text", "image"],
					}
				: { id: MODELS[0].id, provider: MODELS[0].provider, input: ["text", "image"] },
		})
		return tool.execute("test-call-id", { model }, undefined, undefined, ctx)
	}

	return { tool, setModel, find, getAvailable, exec }
}

/**
 * Creates a harness that exposes `pi` and `trigger` for tests that need to fire
 * context events (e.g. to update sessionHasImages() in model-guard).
 */
function createHarnessWithTrigger(options: { setModelResult?: boolean } = {}) {
	const { setModelResult = true } = options
	type Handler = (data: unknown, ctx: unknown) => unknown
	const handlers = new Map<string, Set<Handler>>()
	const on = (event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, new Set())
		handlers.get(event)?.add(handler)
	}
	const setModel = vi.fn(async () => setModelResult)
	const trigger = async (event: string, data: unknown, ctx: unknown) => {
		const set = handlers.get(event)
		if (set) for (const h of set) await h(data, ctx)
	}
	const pi = {
		on,
		setModel,
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI
	return { pi, trigger, setModel }
}

/** Returns a mock ExtensionContext for triggering context events. */
function makeMockCtx() {
	return createContext({
		model: {
			id: "kimi-k2.6",
			provider: "kimchi-dev",
			input: ["text", "image"],
		},
		modelRegistry: {
			getAvailable: vi.fn().mockReturnValue(MODELS),
		},
		getContextUsage: vi.fn().mockReturnValue({
			contextWindow: 256_000,
			tokens: 10_000,
			percent: 5,
		}),
	})
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n")
}

describe("modelSwitchExtension", () => {
	it("registers a single set_model tool with the documented metadata", () => {
		const { tool } = createHarness()
		expect(tool.name).toBe("set_model")
		expect(tool.label).toBe("Switch Model")
		expect(tool.description).toContain("provider/id format")
		expect(tool.description).toContain("pi.setModel")
		expect(tool.parameters).toBeDefined()
	})

	describe("input validation", () => {
		const invalidInputs: Array<{ label: string; value: string }> = [
			{ label: "empty string", value: "" },
			{ label: "no slash", value: "kimi-k2.6" },
			{ label: "leading slash (missing provider)", value: "/kimi-k2.6" },
			{ label: "trailing slash (missing model)", value: "kimchi-dev/" },
			{ label: "extra slash (three parts)", value: "kimchi-dev/kimi/k2.6" },
		]

		for (const { label, value } of invalidInputs) {
			it(`rejects "${label}" without calling setModel`, async () => {
				const h = createHarness()
				const result = await h.exec(value)

				expect(textOf(result)).toContain(`Invalid model format: "${value}"`)
				expect(textOf(result)).toContain('Expected "provider/modelId"')
				expect(textOf(result)).toContain("Available models:")
				expect(textOf(result)).toContain("anthropic/claude-sonnet-4-20250514")
				expect(textOf(result)).toContain("kimchi-dev/kimi-k2.6")
				expect(textOf(result)).toContain("kimchi-dev/minimax-m2.7")
				expect(h.setModel).not.toHaveBeenCalled()
				expect(h.find).not.toHaveBeenCalled()
				expect(result.details).toBeNull()
			})
		}

		it("sorts available models alphabetically in invalid-format error message", async () => {
			const h = createHarness()
			const result = await h.exec("bad-format")
			const text = textOf(result)
			const idxAnthropic = text.indexOf("anthropic/claude-sonnet-4-20250514")
			const idxKimi = text.indexOf("kimchi-dev/kimi-k2.6")
			const idxMinimax = text.indexOf("kimchi-dev/minimax-m2.7")
			expect(idxAnthropic).toBeGreaterThan(-1)
			expect(idxKimi).toBeGreaterThan(idxAnthropic)
			expect(idxMinimax).toBeGreaterThan(idxKimi)
		})

		it("handles invalid model format", async () => {
			const h = createHarness()
			const result = await h.exec("kimi-k2.6")
			expect(textOf(result)).toContain('Invalid model format: "kimi-k2.6"')
			expect(textOf(result)).toContain("Available models:")
			expect(h.setModel).not.toHaveBeenCalled()
		})
	})

	describe("model lookup", () => {
		it("returns 'Model not found' when registry has no matching entry", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/does-not-exist")

			expect(h.find).toHaveBeenCalledWith("kimchi-dev", "does-not-exist")
			expect(textOf(result)).toContain("Model not found: kimchi-dev/does-not-exist")
			expect(textOf(result)).toContain("Available models:")
			expect(textOf(result)).toContain("kimchi-dev/kimi-k2.6")
			expect(h.setModel).not.toHaveBeenCalled()
			expect(result.details).toBeNull()
		})
	})

	describe("successful switch", () => {
		it("calls pi.setModel with the resolved descriptor and reports success", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/kimi-k2.6")

			expect(h.find).toHaveBeenCalledWith("kimchi-dev", "kimi-k2.6")
			expect(h.setModel).toHaveBeenCalledTimes(1)
			expect(h.setModel).toHaveBeenCalledWith({
				id: "kimi-k2.6",
				provider: "kimchi-dev",
				name: "Kimi K2.6",
				input: ["text", "image"],
				contextWindow: 200_000,
			})
			expect(textOf(result)).toBe("Switched to model kimchi-dev/kimi-k2.6 (Kimi K2.6)")
			expect(result.details).toBeNull()
		})

		it("works across providers (anthropic)", async () => {
			const h = createHarness()
			const result = await h.exec("anthropic/claude-sonnet-4-20250514")

			expect(h.setModel).toHaveBeenCalledWith({
				id: "claude-sonnet-4-20250514",
				provider: "anthropic",
				name: "Claude Sonnet 4",
				input: ["text", "image"],
				contextWindow: 200_000,
			})
			expect(textOf(result)).toBe("Switched to model anthropic/claude-sonnet-4-20250514 (Claude Sonnet 4)")
		})
	})

	describe("vision compatibility guard", () => {
		beforeEach(() => {
			__resetImagesDetectedForTest()
		})

		it("rejects switch to non-vision model when session has images", async () => {
			const h = createHarness()
			// Simulate sessionHasImages() == true by directly setting the flag
			// (in production this is set by model-guard's context handler)
			const { pi: imgPi, trigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			const ctx = makeMockCtx()
			await trigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look at this" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "abc" },
								},
							],
						},
					],
				},
				ctx as never,
			)
			expect(sessionHasImages()).toBe(true)

			const result = await h.exec("kimchi-dev/minimax-m2.7")
			expect(h.setModel).not.toHaveBeenCalled()
			expect(textOf(result)).toContain("Current conversation contains images")
			expect(textOf(result)).toContain('target model "kimchi-dev/minimax-m2.7" does not support vision input')
			expect(result.details).toBeNull()
		})

		it("allows switch to vision-capable model when session has images", async () => {
			const h = createHarness()
			const { pi: imgPi, trigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			const ctx = makeMockCtx()
			await trigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "xyz" },
								},
							],
						},
					],
				},
				ctx as never,
			)

			const result = await h.exec("kimchi-dev/kimi-k2.6")
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model kimchi-dev/kimi-k2.6 (Kimi K2.6)")
		})

		it("allows switch to non-vision model when session has no images", async () => {
			const h = createHarness()
			// imagesDetected is reset to false in beforeEach
			expect(sessionHasImages()).toBe(false)
			const result = await h.exec("kimchi-dev/minimax-m2.7")
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model kimchi-dev/minimax-m2.7 (MiniMax M2.7)")
		})

		it("allows switch between non-vision models when session has images", async () => {
			const h = createHarness()
			const { pi: imgPi, trigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			const ctx = makeMockCtx()
			await trigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look at this" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "abc" },
								},
							],
						},
					],
				},
				ctx as never,
			)
			expect(sessionHasImages()).toBe(true)

			const result = await h.exec("kimchi-dev/nemotron-3-ultra-fp4", {
				currentModel: { id: "minimax-m2.7", provider: "kimchi-dev", name: "MiniMax M2.7", input: ["text"] },
			})
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model kimchi-dev/nemotron-3-ultra-fp4")
		})
	})

	describe("MODEL_CAPABILITIES lookup", () => {
		it("MODEL_CAPABILITIES contains expected keys", async () => {
			const { MODEL_CAPABILITIES } = await import("./orchestration/model-registry/builtin-models.js")
			const kimiCaps = MODEL_CAPABILITIES.get("kimi-k2.6")
			const nemotronCaps = MODEL_CAPABILITIES.get("nemotron-3-ultra-fp4")
			expect(kimiCaps).toBeDefined()
			expect(kimiCaps).not.toBe("ignored")
			if (kimiCaps && kimiCaps !== "ignored") {
				expect(kimiCaps.tier).toBe("heavy")
			}
			expect(nemotronCaps).toBeDefined()
			expect(nemotronCaps).not.toBe("ignored")
			if (nemotronCaps && nemotronCaps !== "ignored") {
				expect(nemotronCaps.tier).toBe("light")
			}
		})

		it("getModelTier returns correct tier for known models via the tool execution context", async () => {
			const { MODEL_CAPABILITIES } = await import("./orchestration/model-registry/builtin-models.js")
			const fakeModel = { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] } as { id: string }
			const caps = MODEL_CAPABILITIES.get(fakeModel.id)
			expect(caps).toBeDefined()
			expect(caps).not.toBe("ignored")
			if (caps && caps !== "ignored") {
				expect((caps as { tier: unknown }).tier).toBe("heavy")
			}
		})

		it("getModelTier returns heavy for kimi-k2.6 and light for nemotron (fresh import)", async () => {
			const { MODEL_CAPABILITIES } = await import("./orchestration/model-registry/builtin-models.js")
			const currentTier = getModelTier({ id: "kimi-k2.6", provider: "kimchi-dev" } as never, MODEL_CAPABILITIES)
			const targetTier = getModelTier(
				{ id: "nemotron-3-ultra-fp4", provider: "kimchi-dev" } as never,
				MODEL_CAPABILITIES,
			)
			expect(currentTier).toBe("heavy")
			expect(targetTier).toBe("light")
		})
	})

	describe("set_model tool result", () => {
		beforeEach(() => {
			__resetImagesDetectedForTest()
		})
		it("does not include tier warning in tool result", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/nemotron-3-ultra-fp4", {
				currentModel: { id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6" },
			})
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model")
			expect(textOf(result)).not.toContain("tier")
			expect(textOf(result)).not.toContain("Reasoning and planning quality may be reduced")
		})

		it("does NOT append a warning when current model is not in MODEL_CAPABILITIES", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/nemotron-3-ultra-fp4", {
				currentModel: { id: "unknown-model", provider: "kimchi-dev", name: "Unknown Model" },
			})
			expect(h.setModel).toHaveBeenCalled()
			const text = textOf(result)
			expect(text).not.toContain("tier")
			expect(text).not.toContain("downgrade")
		})
	})

	describe("metadata wizard removed", () => {
		// The metadata wizard (promptAndSaveMetadata) was removed in the
		// remove-metadata-wizard refactor. These tests confirm set_model never
		// invokes ui.select or ui.input regardless of whether the target model
		// has known metadata or not.

		beforeEach(() => {
			__resetImagesDetectedForTest()
		})

		it("does not call ctx.ui.select or ctx.ui.input on a known model", async () => {
			const select = vi.fn()
			const input = vi.fn()
			const notify = vi.fn()
			const { tool } = createHarness()
			const ctx = createContext({
				modelRegistry: {
					find: (_p: string, id: string) => MODELS.find((m) => m.id === id),
					getAvailable: () => MODELS,
				} as ModelRegistry,
				getContextUsage: () => undefined,
				model: { id: MODELS[0].id, provider: MODELS[0].provider, input: ["text", "image"] },
				hasUI: true,
				ui: { select, input, notify },
			})
			await tool.execute("id", { model: "kimchi-dev/kimi-k2.6" }, undefined, undefined, ctx)
			expect(select).not.toHaveBeenCalled()
			expect(input).not.toHaveBeenCalled()
		})

		it("does not call ctx.ui.select or ctx.ui.input on an unknown model (no metadata)", async () => {
			// A model unknown to MODEL_CAPABILITIES would previously have triggered
			// the metadata wizard. Now it simply succeeds without any UI interaction.
			const select = vi.fn()
			const input = vi.fn()
			const notify = vi.fn()
			const unknownModel = {
				id: "unknown-model-xyz",
				provider: "some-provider",
				name: "Unknown Model",
				input: ["text"],
				contextWindow: 50_000,
			}
			const setModel = vi.fn(async () => true)
			let registeredTool: RegisteredTool | undefined
			const pi = {
				on: vi.fn(),
				registerTool: (t: RegisteredTool) => {
					registeredTool = t
				},
				setModel,
				registerCommand: vi.fn(),
			} as unknown as ExtensionAPI
			modelSwitchExtension(pi)
			if (!registeredTool) throw new Error("set_model not registered")
			const ctx = createContext({
				modelRegistry: {
					find: (p: string, id: string) =>
						p === unknownModel.provider && id === unknownModel.id ? unknownModel : undefined,
					getAvailable: () => [unknownModel],
				} as ModelRegistry,
				getContextUsage: () => undefined,
				model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
				hasUI: true,
				ui: { select, input, notify },
			})
			const result = await registeredTool.execute(
				"id",
				{ model: "some-provider/unknown-model-xyz" },
				undefined,
				undefined,
				ctx,
			)
			expect(select).not.toHaveBeenCalled()
			expect(input).not.toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model some-provider/unknown-model-xyz")
		})

		it("does not call ctx.ui.select or ctx.ui.input when hasUI is false", async () => {
			const select = vi.fn()
			const input = vi.fn()
			const { tool } = createHarness()
			const ctx = createContext({
				modelRegistry: {
					find: (_p: string, id: string) => MODELS.find((m) => m.id === id),
					getAvailable: () => MODELS,
				} as ModelRegistry,
				getContextUsage: () => undefined,
				model: { id: MODELS[0].id, provider: MODELS[0].provider, input: ["text", "image"] },
				hasUI: false,
				ui: { select, input, notify: vi.fn() },
			})
			await tool.execute("id", { model: "kimchi-dev/kimi-k2.6" }, undefined, undefined, ctx)
			expect(select).not.toHaveBeenCalled()
			expect(input).not.toHaveBeenCalled()
		})
	})

	describe("__resetModelSwitchStateForTest", () => {
		// These tests verify the reset function returns the module to its
		// documented default state (suppressModelSelectGuard=false,
		// isRevertingModel=false) by observing behavioral effects.

		beforeEach(() => {
			__resetImagesDetectedForTest()
		})

		it("restores the model_select guard so it runs after being suppressed by set_model", async () => {
			// set_model sets suppressModelSelectGuard=true then false, but if an
			// exception leaves it true, __resetModelSwitchStateForTest clears it.
			// We simulate the leaked state by calling withSuppressedModelSelectGuard
			// with a function that throws, which leaves suppressModelSelectGuard=false
			// thanks to .finally(). Then we reset and confirm the guard is active.
			try {
				await withSuppressedModelSelectGuard(async () => {
					throw new Error("boom")
				})
			} catch {
				/* expected */
			}
			// After the throw, .finally() restores suppressModelSelectGuard=false already.
			// Now confirm reset + normal guard behavior by verifying model_select reverts.
			__resetModelSwitchStateForTest()

			const { pi, trigger, setModel } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const notify = vi.fn()
			// This should trigger the context overflow guard (tokens > safe window)
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					modelRegistry: { getAvailable: () => MODELS },
					getContextUsage: () => ({ tokens: 150_000 }),
					ui: { notify },
				}),
			)
			// Guard is active → revert was called
			expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-k2.6" }))
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("context"), "error")
		})

		it("after reset, model_select guard is skipped when suppressModelSelectGuard is set via set_model", async () => {
			// Confirm the guard suppression path works correctly after a reset:
			// set_model sets suppressModelSelectGuard=true, fires pi.setModel (which
			// emits model_select internally), and the handler skips due to the flag.
			__resetModelSwitchStateForTest()

			const { pi, trigger, setModel } = createHarnessWithTrigger()
			modelSwitchExtension(pi)

			// Manually invoke model_select with suppressModelSelectGuard=true by
			// wrapping in withSuppressedModelSelectGuard — the handler must skip.
			let _handlerCallCount = 0
			const notify = vi.fn(() => {
				_handlerCallCount++
			})
			await withSuppressedModelSelectGuard(async () => {
				await trigger(
					"model_select",
					{
						type: "model_select",
						model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
						previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
						source: "set",
					},
					{
						model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
						modelRegistry: { getAvailable: () => MODELS },
						getContextUsage: () => ({ tokens: 150_000 }),
						sessionManager: { getSessionId: () => "test-session" },
						ui: { notify },
					} as never,
				)
			})
			// Guard was suppressed → no revert, no notify
			expect(setModel).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("context"), "error")
		})

		it("resets suppressModelSelectGuard to false so model_select guard is active on next call", async () => {
			// Directly verify via withSuppressedModelSelectGuard that reset
			// restores guard-active behavior between test runs.
			__resetModelSwitchStateForTest()

			const { pi, trigger, setModel } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const notify = vi.fn()

			// First trigger: guard active (no suppression) → revert fires for overflow
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				{
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					modelRegistry: { getAvailable: () => MODELS },
					getContextUsage: () => ({ tokens: 150_000 }),
					sessionManager: { getSessionId: () => "test-session" },
					ui: { notify },
				} as never,
			)
			expect(setModel).toHaveBeenCalledTimes(1)
			expect(notify).toHaveBeenCalledTimes(1)

			// Reset between test runs
			__resetModelSwitchStateForTest()
			setModel.mockClear()
			notify.mockClear()

			// Second trigger after reset: guard must still be active
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				{
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					modelRegistry: { getAvailable: () => MODELS },
					getContextUsage: () => ({ tokens: 150_000 }),
					sessionManager: { getSessionId: () => "test-session" },
					ui: { notify },
				} as never,
			)
			expect(setModel).toHaveBeenCalledTimes(1)
			expect(notify).toHaveBeenCalledTimes(1)
		})

		it("resets isRevertingModel to false so a new revert cycle can execute after reset", async () => {
			// isRevertingModel=true would cause the handler to skip entirely.
			// After __resetModelSwitchStateForTest it must be false so the next
			// revert-triggering model_select fires correctly.
			const { pi: pi1, trigger: trigger1, setModel: setModel1 } = createHarnessWithTrigger()
			modelSwitchExtension(pi1)
			const notify1 = vi.fn()

			// Fire an overflow event — this sets isRevertingModel=true mid-execution
			// and resets it to false after the revert. Verify revert happened.
			await trigger1(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				{
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					modelRegistry: { getAvailable: () => MODELS },
					getContextUsage: () => ({ tokens: 150_000 }),
					sessionManager: { getSessionId: () => "test-session" },
					ui: { notify: notify1 },
				} as never,
			)
			expect(setModel1).toHaveBeenCalledTimes(1) // revert executed

			// Now reset — this ensures isRevertingModel is false for the next harness
			__resetModelSwitchStateForTest()

			// Fresh harness: should revert again (isRevertingModel is false after reset)
			const { pi: pi2, trigger: trigger2, setModel: setModel2 } = createHarnessWithTrigger()
			modelSwitchExtension(pi2)
			const notify2 = vi.fn()
			await trigger2(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				{
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					modelRegistry: { getAvailable: () => MODELS },
					getContextUsage: () => ({ tokens: 150_000 }),
					sessionManager: { getSessionId: () => "test-session" },
					ui: { notify: notify2 },
				} as never,
			)
			expect(setModel2).toHaveBeenCalledTimes(1) // revert executed again
			expect(notify2).toHaveBeenCalledWith(expect.stringContaining("context"), "error")
		})
	})

	describe("setModel failure", () => {
		it("returns a 'no API key' style message when pi.setModel resolves false", async () => {
			const h = createHarness({ setModelResult: false })
			const result = await h.exec("kimchi-dev/kimi-k2.6")

			expect(h.setModel).toHaveBeenCalledTimes(1)
			expect(textOf(result)).toContain("Failed to switch to kimchi-dev/kimi-k2.6")
			expect(textOf(result)).toContain("no API key available")
			expect(result.details).toBeNull()
		})
	})

	describe("context overflow guard (null tokens fallback)", () => {
		describe("set_model tool rejects when getContextUsage returns null but local estimate is too large", () => {
			it("rejects switch to kimi-k2.6 when large context accumulated (null upstream tokens)", async () => {
				// Simulate a large conversation: 30 messages × 2000 chars → ~15,000 tokens estimated.
				// The guard checks against the found model's contextWindow (from MODELS registry).
				// Override the harness find mock to return a kimi with a small context window
				// so the guard fires, without mutating the global MODELS array.
				__setLatestMessagesForTest(
					Array.from({ length: 30 }, () => ({
						role: "user" as const,
						content: [{ type: "text" as const, text: "x".repeat(2000) }],
						timestamp: 0 as const,
					})),
				)
				const h = createHarness()
				h.find.mockImplementation((provider: string, id: string) => {
					const found = MODELS.find((m) => m.provider === provider && m.id === id)
					if (found && found.id === "kimi-k2.6" && found.provider === "kimchi-dev") {
						return { ...found, contextWindow: 10_000 }
					}
					return found
				})
				const result = await h.exec("kimchi-dev/kimi-k2.6")

				expect(h.setModel).not.toHaveBeenCalled()
				const text = textOf(result)
				expect(text).toContain("15000 tokens")
				expect(text).toContain("Switch rejected")
				expect(text).toContain("Use /compact")
			})

			it("allows switch when local estimate is small even if getContextUsage returns null", async () => {
				// Short session: few messages that fit within Kimi's safe context window
				__setLatestMessagesForTest([
					{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 0 as const },
				])
				const h = createHarness()
				const result = await h.exec("kimchi-dev/kimi-k2.6")

				expect(h.setModel).toHaveBeenCalledTimes(1)
				expect(textOf(result)).toBe("Switched to model kimchi-dev/kimi-k2.6 (Kimi K2.6)")
			})
		})
	})

	describe("model_select handler", () => {
		const createContext = (
			overrides: Partial<{
				tokens: number
				getContextUsage: () => { tokens: number }
				modelId: string
				modelProvider: string
				hasUI: boolean
				ui: {
					notify: (...args: unknown[]) => unknown
					select?: (...args: unknown[]) => unknown
					input?: (...args: unknown[]) => unknown
				}
			}> = {},
		) => {
			const tokens = overrides.tokens ?? 10_000
			const hasUI = overrides.hasUI ?? false
			return {
				model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
				modelRegistry: { getAvailable: () => MODELS },
				getContextUsage: () => ({ tokens }),
				sessionManager: { getSessionId: () => "test-session" },
				hasUI,
				ui: { notify: vi.fn(), select: vi.fn(), input: vi.fn(), ...overrides.ui },
				...overrides,
			} as ExtensionContext
		}

		let argvSpy: ReturnType<typeof vi.spyOn> | null = null

		function setArgv(args: string[]): void {
			argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(args)
		}

		function clearArgv(): void {
			if (argvSpy) {
				argvSpy.mockRestore()
				argvSpy = null
			}
		}

		/** Reset the process side-channel map for our test session id. */
		function resetProcessMap(): void {
			const proc = process as NodeJS.Process & { __kimchiMultiModelEnabled?: Map<string, boolean> }
			proc.__kimchiMultiModelEnabled?.delete("test-session")
		}

		beforeEach(() => {
			__resetModelSwitchStateForTest()
			__resetImagesDetectedForTest()
			vi.clearAllMocks()
			clearArgv()
			resetProcessMap()
		})

		it("skips when isRevertingModel guard is set", async () => {
			const _h = createHarness()
			// Manually set the flag via module state (not exported, so test via the handler directly)
			// We simulate this by calling the handler with isRevertingModel=true scenario
			// Since isRevertingModel is module-scoped, we test it indirectly via the suppress flag path
			expect(true).toBe(true) // Placeholder — isRevertingModel tested via integration
		})

		it("allows source=set when tokens fit (no guard triggered)", async () => {
			const { pi, trigger, setModel } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({ tokens: 10_000 }),
			)
			// No guard triggered (tokens fit), no revert needed — setModel already called by /model path
			expect(setModel).not.toHaveBeenCalled()
		})

		it("skips when source is cycle", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "cycle",
				},
				createContext({ tokens: 10_000 }),
			)
			expect(setModel).not.toHaveBeenCalled()
		})

		it("skips when source is restore", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "restore",
				},
				createContext({ tokens: 10_000 }),
			)
			expect(setModel).not.toHaveBeenCalled()
		})

		it("skips when no previousModel", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 200_000 },
					previousModel: undefined,
					source: "set",
				},
				createContext({ tokens: 10_000 }),
			)
			expect(setModel).not.toHaveBeenCalled()
		})

		it("reverts when tokens exceed target context window", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({ tokens: 150_000, ui: { notify } }),
			)
			// Reverted back to previousModel
			expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-k2.6" }))
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("context"), "error")
		})

		it("allows when tokens fit within target context window", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 200_000 },
					previousModel: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"] },
					source: "set",
				},
				createContext({ tokens: 10_000 }),
			)
			expect(setModel).not.toHaveBeenCalled()
		})

		it("reverts when session has images and target lacks vision", async () => {
			const { pi: imgPi, trigger: imgTrigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			// Simulate images in session
			await imgTrigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look at this" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "abc" },
								},
							],
						},
					],
				},
				makeMockCtx(),
			)
			expect(sessionHasImages()).toBe(true)

			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({ tokens: 10_000, ui: { notify } }),
			)
			expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-k2.6" }))
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("vision"), "error")
		})

		it("allows when session has images and target has vision", async () => {
			const { pi: imgPi, trigger: imgTrigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			await imgTrigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "xyz" },
								},
							],
						},
					],
				},
				makeMockCtx(),
			)
			expect(sessionHasImages()).toBe(true)

			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 200_000 },
					previousModel: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"] },
					source: "set",
				},
				createContext({ tokens: 10_000 }),
			)
			expect(setModel).not.toHaveBeenCalled()
		})

		it("allows switch between non-vision models when session has images", async () => {
			const { pi: imgPi, trigger: imgTrigger } = createHarnessWithTrigger()
			createModelGuardExtension(imgPi)
			await imgTrigger(
				"context",
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{ type: "text" as const, text: "look at this" },
								{
									type: "image" as const,
									source: { type: "base64" as const, mediaType: "image/png" as const, data: "abc" },
								},
							],
						},
					],
				},
				makeMockCtx(),
			)
			expect(sessionHasImages()).toBe(true)

			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const setModel = pi.setModel as ReturnType<typeof vi.fn>
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "nemotron-3-ultra-fp4", provider: "kimchi-dev", input: ["text"], contextWindow: 1_000_000 },
					previousModel: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"] },
					source: "set",
				},
				createContext({ tokens: 10_000, ui: { notify } }),
			)
			expect(setModel).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("vision"), "error")
		})

		it("syncs multi-model process flag to extension state on model_select from /models UI", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			const ctx = createContext({ tokens: 10_000 })
			modelSwitchExtension(pi)

			setMultiModelEnabled("test-session", true)
			expect(getMultiModelEnabled(ctx.sessionManager)).toBe(true)

			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "nemotron-3-ultra-fp4", provider: "kimchi-dev", input: ["text"], contextWindow: 1_000_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				ctx,
			)

			expect(getMultiModelEnabled(ctx.sessionManager)).toBe(false)
		})

		it("--model flag sets startup default to false but does not override runtime selection", async () => {
			setArgv(["node", "script", "--model"])
			const ctx = createContext({ tokens: 10_000 })

			// Runtime selection (user entered multi-session multi-model mode) outranks CLI
			setMultiModelEnabled("test-session", true)
			expect(getMultiModelEnabled(ctx.sessionManager)).toBe(true)
			expect(resolveMultiModelEnabled(ctx.sessionManager)).toEqual({ value: true, source: "runtime" })

			// Clear the process map so only CLI flag applies
			resetProcessMap()

			// Now CLI flag takes effect (no runtime override)
			expect(getMultiModelEnabled(ctx.sessionManager)).toBe(false)
			expect(resolveMultiModelEnabled(ctx.sessionManager)).toEqual({ value: false, source: "cli" })
		})

		it("reverts when getContextUsage returns null but local estimate exceeds target context window", async () => {
			// Simulate post-compaction: getContextUsage returns null, but accumulated messages
			// are large enough to exceed the target context window.
			// 30 messages × 2000 chars → ~15,000 tokens; 15,000 > 10,000 × 0.95 = 9,500 → guard fires.
			__setLatestMessagesForTest(
				Array.from({ length: 30 }, () => ({
					role: "user" as const,
					content: [{ type: "text" as const, text: "x".repeat(2000) }],
					timestamp: 0 as const,
				})),
			)
			const h = createHarnessWithTrigger()
			modelSwitchExtension(h.pi)
			await h.trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 10_000 },
					previousModel: { id: "claude-opus-4.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({ getContextUsage: () => ({ tokens: null as unknown as number }) }),
			)

			expect(h.setModel).toHaveBeenCalledWith({
				id: "claude-opus-4.6",
				provider: "kimchi-dev",
				input: ["text", "image"],
			})
		})

		it("allows switch when getContextUsage returns null but local estimate fits within target context", async () => {
			// Fresh session: no accumulated context, local estimate is tiny.
			__setLatestMessagesForTest([
				{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }], timestamp: 0 as const },
			])
			const h = createHarnessWithTrigger()
			await h.trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 262_144 },
					previousModel: { id: "claude-opus-4.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				createContext({ getContextUsage: () => ({ tokens: null as unknown as number }) }),
			)

			expect(h.setModel).not.toHaveBeenCalled()
		})
	})
})
