import type { Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { resolveRecommendation } from "./selection.js"

function model(id: string, input: ("text" | "image")[] = ["text"], provider = "kimchi-dev"): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	}
}

function context(available: Model<string>[], scopedModels: Model<string>[] = []) {
	return createContext({
		modelRegistry: { getAvailable: () => available },
		scopedModels: scopedModels.map((entry) => ({ model: entry })),
	})
}

function recommendation(bestModel: string, probabilities: Record<string, number> = {}) {
	return { bestModel, probabilities }
}

describe("resolveRecommendation", () => {
	it("accepts the router's exact available concrete kimchi-dev model", () => {
		const target = model("kimi-k2.5", ["text", "image"])
		expect(resolveRecommendation(recommendation("kimi-k2.5", { "kimi-k2.5": 0.9 }), context([target]), false)).toEqual({
			ok: true,
			model: target,
		})
	})

	it.each([
		["an unknown model", "missing", [model("known")]],
		["Auto itself", "auto", [model("auto")]],
		["a same-id model from another provider", "shared", [model("shared", ["text"], "other")]],
	] as const)("rejects %s", (_label, recommendation, available) => {
		expect(
			resolveRecommendation({ bestModel: recommendation, probabilities: {} }, context([...available]), false),
		).toEqual({
			ok: false,
			reason: "unavailable_recommendation",
		})
	})

	it("uses the highest-ranked remaining vision model when the best model lacks vision", () => {
		const textOnly = model("text-only")
		const vision = model("vision", ["text", "image"])
		expect(
			resolveRecommendation(
				recommendation("text-only", { "text-only": 0.9, vision: 0.7 }),
				context([textOnly, vision]),
				true,
			),
		).toEqual({
			ok: true,
			model: vision,
		})
	})

	it("uses the highest-ranked remaining scoped model when the best model is outside the active scope", () => {
		const recommended = model("recommended")
		const lowerRanked = model("lower-ranked")
		const highestRankedScoped = model("highest-ranked-scoped")
		expect(
			resolveRecommendation(
				recommendation("recommended", {
					recommended: 0.9,
					"lower-ranked": 0.4,
					"highest-ranked-scoped": 0.7,
				}),
				context([recommended, lowerRanked, highestRankedScoped], [lowerRanked, highestRankedScoped]),
				false,
			),
		).toEqual({
			ok: true,
			model: highestRankedScoped,
		})
	})

	it("stops when no ranked candidate supports required vision", () => {
		const textOnly = model("text-only")
		expect(resolveRecommendation(recommendation("text-only", { "text-only": 0.9 }), context([textOnly]), true)).toEqual(
			{
				ok: false,
				reason: "vision_required",
			},
		)
	})
})
