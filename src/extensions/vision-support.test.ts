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

	it("bypasses the Auto model explicitly", () => {
		// Auto advertises image input but the router is not image-aware — the
		// gate must not fire for it.
		const auto = makeModel({ provider: "kimchi-dev", id: "auto", input: ["text", "image"] })
		expect(needsVisionSwitch(auto)).toBe(false)
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

	it("excludes Auto even though it advertises image input", () => {
		const available = [
			makeModel({ provider: "kimchi-dev", id: "auto", input: ["text", "image"] }),
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
})
