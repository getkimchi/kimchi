import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import modelSwitchExtension from "./model-switch.js"

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

type ModelEntry = { id: string; provider: string; name: string }

interface Harness {
	tool: RegisteredTool
	setModel: ReturnType<typeof vi.fn>
	find: ReturnType<typeof vi.fn>
	getAvailable: ReturnType<typeof vi.fn>
	exec: (
		model: string,
		opts?: { omitRegistry?: boolean },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

const MODELS: ModelEntry[] = [
	{ id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6" },
	{ id: "minimax-m2.7", provider: "kimchi-dev", name: "MiniMax M2.7" },
	{ id: "claude-sonnet-4-20250514", provider: "anthropic", name: "Claude Sonnet 4" },
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
	} as unknown as ExtensionAPI

	modelSwitchExtension(pi)

	if (!registered) throw new Error("set_model tool was not registered")
	const tool = registered

	const exec: Harness["exec"] = (model, opts = {}) => {
		const ctx = opts.omitRegistry ? {} : { modelRegistry: { find, getAvailable } }
		return tool.execute("test-call-id", { model }, undefined, undefined, ctx)
	}

	return { tool, setModel, find, getAvailable, exec }
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
			})
			expect(textOf(result)).toBe("Switched to model anthropic/claude-sonnet-4-20250514 (Claude Sonnet 4)")
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
})
