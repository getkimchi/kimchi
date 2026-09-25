import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import { autoModelForTarget, hasTargetCapabilities, syncAutoCapabilities } from "./capabilities.js"

const TLM = { off: "none", max: "max" } as const

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "auto",
		name: "auto",
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 16_384,
		thinkingLevelMap: TLM,
		...overrides,
	}
}

describe("hasTargetCapabilities", () => {
	// The comparison uses reference equality on reasoning/thinkingLevelMap and
	// value equality on contextWindow/maxTokens, matching the original v1
	// helper. Share the same object references when expecting a match.
	it("is true when all four capabilities match", () => {
		const identical = model()
		expect(hasTargetCapabilities(identical, identical)).toBe(true)
	})

	it("distinguishes each dimension", () => {
		expect(hasTargetCapabilities(model(), model({ contextWindow: 64_000 }))).toBe(false)
		expect(hasTargetCapabilities(model(), model({ maxTokens: 32_768 }))).toBe(false)
		const reasoningOff = model({ reasoning: false })
		expect(hasTargetCapabilities(model(), reasoningOff)).toBe(false)
		const otherTlm = model({ thinkingLevelMap: { off: "none" } })
		expect(hasTargetCapabilities(model(), otherTlm)).toBe(false)
	})
})

describe("autoModelForTarget", () => {
	it("clones the virtual model with the target's real capabilities", () => {
		const target = model({
			id: "kimi-k3",
			contextWindow: 128_000,
			maxTokens: 4096,
			reasoning: true,
			thinkingLevelMap: { off: "none", high: "high", max: "max" },
		})
		const virtual = model({ id: "auto-beta" })
		const synced = autoModelForTarget(virtual, target)

		expect(synced.id).toBe("auto-beta")
		expect(synced.contextWindow).toBe(128_000)
		expect(synced.maxTokens).toBe(4096)
		expect(synced.reasoning).toBe(true)
		expect(synced.thinkingLevelMap).toEqual({ off: "none", high: "high", max: "max" })
	})
})

describe("syncAutoCapabilities", () => {
	it("skips setModel when capabilities already match the target", async () => {
		const pi = { setModel: vi.fn(async () => true) } as unknown as Parameters<typeof syncAutoCapabilities>[0]
		const virtual = model()
		const ok = await syncAutoCapabilities(pi, virtual, virtual)
		expect(ok).toBe(true)
		expect(pi.setModel).not.toHaveBeenCalled()
	})

	it("re-applies the model with target capabilities when they differ", async () => {
		const pi = { setModel: vi.fn(async () => true) } as unknown as Parameters<typeof syncAutoCapabilities>[0]
		const virtual = model({ id: "auto-beta", contextWindow: 1_048_576 })
		const target = model({ id: "kimi-k3", contextWindow: 128_000, maxTokens: 4096, thinkingLevelMap: TLM })
		const ok = await syncAutoCapabilities(pi, virtual, target)
		expect(ok).toBe(true)
		expect(pi.setModel).toHaveBeenCalledTimes(1)
		const applied = vi.mocked(pi.setModel).mock.calls[0]?.[0] as Model<Api>
		expect(applied.id).toBe("auto-beta")
		expect(applied.contextWindow).toBe(128_000)
		expect(applied.maxTokens).toBe(4096)
	})

	it("returns false when setModel fails", async () => {
		const pi = { setModel: vi.fn(async () => false) } as unknown as Parameters<typeof syncAutoCapabilities>[0]
		const ok = await syncAutoCapabilities(pi, model(), model({ contextWindow: 64_000 }))
		expect(ok).toBe(false)
	})
})
