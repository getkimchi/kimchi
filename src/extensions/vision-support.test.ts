import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	humanizeContextWindow,
	modelSupportsImages,
	needsVisionSwitch,
	visionModelCandidates,
} from "./vision-support.js"

function makeModel(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		provider: "kimchi-dev",
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		contextWindow: 200_000,
		maxTokens: 16_384,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<Api>
}

describe("modelSupportsImages", () => {
	it("reads capability from the live model's input modalities", () => {
		expect(modelSupportsImages(makeModel({ input: ["text", "image"] }))).toBe(true)
		expect(modelSupportsImages(makeModel({ input: ["text"] }))).toBe(false)
	})

	it("accepts images on backend-routed virtual models regardless of the descriptor", () => {
		// The backend picks a concrete model per request; the descriptor's
		// modalities do not reflect the routed pool (the clipboard path relies
		// on this — see auto-model/constants' isAutoRoutedModel).
		expect(modelSupportsImages(makeModel({ provider: "kimchi-dev", id: "auto", input: ["text"] }))).toBe(true)
		expect(modelSupportsImages(makeModel({ provider: "kimchi-dev", id: "auto-beta", input: ["text"] }))).toBe(true)
	})

	it("agrees with the model descriptor, not the catalog slug", () => {
		// Provider/id collisions must not matter: the capability comes from the
		// model object itself, not a metadata lookup by slug.
		const model = makeModel({ provider: "other", id: "glm-4", input: ["text"] })
		expect(modelSupportsImages(model)).toBe(false)
	})

	it("handles missing models", () => {
		expect(modelSupportsImages(undefined)).toBe(false)
		expect(modelSupportsImages(null)).toBe(false)
	})
})

describe("needsVisionSwitch", () => {
	it("engages for concrete text-only models", () => {
		expect(needsVisionSwitch(makeModel({ input: ["text"] }))).toBe(true)
	})

	it("does not engage for vision models", () => {
		expect(needsVisionSwitch(makeModel({ input: ["text", "image"] }))).toBe(false)
	})

	it("bypasses backend-routed virtual models explicitly", () => {
		// The backend resolves a concrete model per request and accepts image
		// input — the gate must not fire for the whole `auto*` namespace,
		// whatever the descriptor claims.
		expect(needsVisionSwitch(makeModel({ provider: "kimchi-dev", id: "auto", input: ["text"] }))).toBe(false)
		expect(needsVisionSwitch(makeModel({ provider: "kimchi-dev", id: "auto-beta", input: ["text"] }))).toBe(false)
	})

	it("handles missing models", () => {
		expect(needsVisionSwitch(undefined)).toBe(false)
		expect(needsVisionSwitch(null)).toBe(false)
	})
})

describe("visionModelCandidates", () => {
	it("keeps vision models and excludes text-only ones", () => {
		const available = [
			makeModel({ id: "text-a", input: ["text"] }),
			makeModel({ id: "vision-a", input: ["text", "image"] }),
			makeModel({ id: "text-b", input: ["text"] }),
			makeModel({ id: "vision-b", input: ["text", "image"] }),
		]
		expect(visionModelCandidates(available).map((m) => m.id)).toEqual(["vision-a", "vision-b"])
	})

	it("excludes backend-routed virtual models even though they accept images", () => {
		// Switching to Auto cannot guarantee a vision-capable concrete pick, so
		// the dialog never offers the `auto*` namespace as a target.
		const available = [
			makeModel({ provider: "kimchi-dev", id: "auto", input: ["text", "image"] }),
			makeModel({ provider: "kimchi-dev", id: "auto-beta", input: ["text", "image"] }),
			makeModel({ id: "vision-a", input: ["text", "image"] }),
		]
		expect(visionModelCandidates(available).map((m) => m.id)).toEqual(["vision-a"])
	})
})

describe("humanizeContextWindow", () => {
	it("renders integral thousands compactly", () => {
		expect(humanizeContextWindow(200_000)).toBe("200k")
		expect(humanizeContextWindow(128_000)).toBe("128k")
	})

	it("renders integral millions with the M suffix", () => {
		expect(humanizeContextWindow(1_000_000)).toBe("1M")
		expect(humanizeContextWindow(2_000_000)).toBe("2M")
	})

	it("keeps one decimal for fractional millions", () => {
		expect(humanizeContextWindow(1_500_000)).toBe("1.5M")
	})

	it("renders sub-thousand windows verbatim", () => {
		expect(humanizeContextWindow(800)).toBe("800")
	})

	it("matches the /model table's formatTokens rendering", () => {
		// The /model capability table renders context with formatTokens plus the
		// ".0M" → "M" cleanup; the vision-switch table must render identically so
		// the same window never looks different between the two.
		expect(humanizeContextWindow(1_000)).toBe("1.0k")
		expect(humanizeContextWindow(8_500)).toBe("8.5k")
		expect(humanizeContextWindow(9_999)).toBe("10.0k")
		expect(humanizeContextWindow(9_500_000)).toBe("9.5M")
		expect(humanizeContextWindow(12_000_000)).toBe("12M")
	})
})
