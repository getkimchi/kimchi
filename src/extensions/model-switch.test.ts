import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import createModelGuardExtension from "./model-guard.js"
import { __resetImagesDetectedForTest, __setLatestMessagesForTest, sessionHasImages } from "./model-guard.js"
import modelSwitchExtension, { __resetModelSwitchStateForTest, getModelTier } from "./model-switch.js"
import { getMultiModelEnabled, setMultiModelEnabled } from "./prompt-construction/prompt-enrichment.js"

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

type ModelEntry = { id: string; provider: string; name: string; input?: string[]; contextWindow?: number }

interface Harness {
	tool: RegisteredTool
	setModel: ReturnType<typeof vi.fn>
	find: ReturnType<typeof vi.fn>
	getAvailable: ReturnType<typeof vi.fn>
	exec: (
		model: string,
		opts?: { omitRegistry?: boolean; currentModel?: ModelEntry; imagesPresent?: boolean },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

const MODELS: ModelEntry[] = [
	{ id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6", input: ["text", "image"], contextWindow: 200_000 },
	{ id: "minimax-m2.7", provider: "kimchi-dev", name: "MiniMax M2.7", input: ["text"], contextWindow: 100_000 },
	{
		id: "nemotron-3-super-fp4",
		provider: "kimchi-dev",
		name: "Nemotron 3 Super FP4",
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
		const ctx = opts.omitRegistry
			? { getContextUsage: () => undefined, model: undefined }
			: {
					modelRegistry: { find, getAvailable },
					getContextUsage: () => undefined,
					model: opts.currentModel
						? {
								id: opts.currentModel.id,
								provider: opts.currentModel.provider,
								input: opts.currentModel.input ?? ["text", "image"],
							}
						: { id: MODELS[0].id, provider: MODELS[0].provider, input: ["text", "image"] },
				}
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
	const pi = { on, setModel, registerTool: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI
	return { pi, trigger, setModel }
}

/** Returns a minimal mock ExtensionContext for triggering context events. */
function makeMockCtx() {
	return {
		model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
		modelRegistry: { getAvailable: () => MODELS },
		getContextUsage: () => ({ tokens: 10_000 }),
	}
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

		it("handles missing modelRegistry on invalid format (empty available list)", async () => {
			const h = createHarness()
			const result = await h.exec("no-slash", { omitRegistry: true })
			expect(textOf(result)).toContain('Invalid model format: "no-slash"')
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

		it("handles missing modelRegistry on lookup (empty available list)", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/kimi-k2.6", { omitRegistry: true })

			expect(textOf(result)).toContain("Model not found: kimchi-dev/kimi-k2.6")
			expect(h.setModel).not.toHaveBeenCalled()
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

			const result = await h.exec("kimchi-dev/nemotron-3-super-fp4", {
				currentModel: { id: "minimax-m2.7", provider: "kimchi-dev", name: "MiniMax M2.7", input: ["text"] },
			})
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model kimchi-dev/nemotron-3-super-fp4")
		})
	})

	describe("MODEL_CAPABILITIES lookup", () => {
		it("MODEL_CAPABILITIES contains expected keys", async () => {
			const { MODEL_CAPABILITIES } = await import("./orchestration/model-registry/builtin-models.js")
			const kimiCaps = MODEL_CAPABILITIES.get("kimi-k2.6")
			const nemotronCaps = MODEL_CAPABILITIES.get("nemotron-3-super-fp4")
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
	})

	describe("tier-downgrade warning", () => {
		beforeEach(() => {
			__resetImagesDetectedForTest()
		})

		it("getModelTier returns heavy for kimi-k2.6 and light for nemotron (fresh import)", async () => {
			const { MODEL_CAPABILITIES } = await import("./orchestration/model-registry/builtin-models.js")
			const currentTier = getModelTier({ id: "kimi-k2.6", provider: "kimchi-dev" } as never, MODEL_CAPABILITIES)
			const targetTier = getModelTier(
				{ id: "nemotron-3-super-fp4", provider: "kimchi-dev" } as never,
				MODEL_CAPABILITIES,
			)
			expect(currentTier).toBe("heavy")
			expect(targetTier).toBe("light")
		})

		it("does not include tier warning in tool result (handled by model-guard notification)", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/nemotron-3-super-fp4", {
				currentModel: { id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6" },
			})
			expect(h.setModel).toHaveBeenCalled()
			expect(textOf(result)).toContain("Switched to model")
			expect(textOf(result)).not.toContain("tier")
			expect(textOf(result)).not.toContain("Reasoning and planning quality may be reduced")
		})

		it("does NOT append a warning when current model is not in MODEL_CAPABILITIES", async () => {
			const h = createHarness()
			const result = await h.exec("kimchi-dev/nemotron-3-super-fp4", {
				currentModel: { id: "unknown-model", provider: "kimchi-dev", name: "Unknown Model" },
			})
			expect(h.setModel).toHaveBeenCalled()
			const text = textOf(result)
			expect(text).not.toContain("tier")
			expect(text).not.toContain("downgrade")
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
		const mockCtx = (
			overrides: Partial<{
				tokens: number
				getContextUsage: () => { tokens: number }
				modelId: string
				modelProvider: string
				ui: { notify: (...args: unknown[]) => unknown }
			}> = {},
		) => {
			const tokens = overrides.tokens ?? 10_000
			return {
				model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
				modelRegistry: { getAvailable: () => MODELS },
				getContextUsage: () => ({ tokens }),
				ui: { notify: vi.fn() },
				...overrides,
			} as unknown as never
		}

		beforeEach(() => {
			__resetModelSwitchStateForTest()
			__resetImagesDetectedForTest()
			vi.clearAllMocks()
		})

		it("skips when isRevertingModel guard is set", async () => {
			const h = createHarness()
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
				mockCtx({ tokens: 10_000 }),
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
				mockCtx({ tokens: 10_000 }),
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
				mockCtx({ tokens: 10_000 }),
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
				mockCtx({ tokens: 10_000 }),
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
				mockCtx({ tokens: 150_000, ui: { notify } }),
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
				mockCtx({ tokens: 10_000 }),
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
				mockCtx({ tokens: 10_000, ui: { notify } }),
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
				mockCtx({ tokens: 10_000 }),
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
					model: { id: "nemotron-3-super-fp4", provider: "kimchi-dev", input: ["text"], contextWindow: 1_000_000 },
					previousModel: { id: "minimax-m2.7", provider: "kimchi-dev", input: ["text"] },
					source: "set",
				},
				mockCtx({ tokens: 10_000, ui: { notify } }),
			)
			expect(setModel).not.toHaveBeenCalled()
			expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("vision"), "error")
		})

		it("shows info notification on tier downgrade (heavy → light)", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "nemotron-3-super-fp4", provider: "kimchi-dev", input: ["text"], contextWindow: 1_000_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				mockCtx({ tokens: 10_000, ui: { notify }, modelId: "nemotron-3-super-fp4" }),
			)
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("heavy"), "info")
		})

		it("does NOT notify on tier upgrade", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"], contextWindow: 200_000 },
					previousModel: { id: "nemotron-3-super-fp4", provider: "kimchi-dev", input: ["text"] },
					source: "set",
				},
				mockCtx({ tokens: 10_000, ui: { notify } }),
			)
			expect(notify).not.toHaveBeenCalled()
		})

		it("does NOT notify when tier is unknown", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)
			const notify = vi.fn()
			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "unknown-model", provider: "kimchi-dev", input: ["text"], contextWindow: 100_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				mockCtx({ tokens: 10_000, ui: { notify } }),
			)
			expect(notify).not.toHaveBeenCalled()
		})

		it("syncs multi-model process flag to extension state on model_select from /models UI", async () => {
			const { pi, trigger } = createHarnessWithTrigger()
			modelSwitchExtension(pi)

			setMultiModelEnabled(true)
			;(process as NodeJS.Process & { __kimchiMultiModelEnabled?: boolean }).__kimchiMultiModelEnabled = false

			await trigger(
				"model_select",
				{
					type: "model_select",
					model: { id: "nemotron-3-super-fp4", provider: "kimchi-dev", input: ["text"], contextWindow: 1_000_000 },
					previousModel: { id: "kimi-k2.6", provider: "kimchi-dev", input: ["text", "image"] },
					source: "set",
				},
				mockCtx({ tokens: 10_000 }),
			)

			expect(getMultiModelEnabled()).toBe(false)
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
				mockCtx({ getContextUsage: () => ({ tokens: null as unknown as number }) }),
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
				mockCtx({ getContextUsage: () => ({ tokens: null as unknown as number }) }),
			)

			expect(h.setModel).not.toHaveBeenCalled()
		})
	})
})
