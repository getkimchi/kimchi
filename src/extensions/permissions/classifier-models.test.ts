import { describe, expect, it } from "vitest"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { DEFAULT_CLASSIFIER_CANDIDATE_REFS, resolveClassifierCandidates } from "./classifier-models.js"

const primary = createModel("deepseek-v4-flash-0731")
const glm = createModel("glm-5.3-flash")
const fallback = createModel("minimax-m3")
const [primaryRef, glmRef, fallbackRef] = DEFAULT_CLASSIFIER_CANDIDATE_REFS

describe("resolveClassifierCandidates", () => {
	it("pins the ordered kimchi-dev ladder", () => {
		expect(DEFAULT_CLASSIFIER_CANDIDATE_REFS).toEqual([
			"kimchi-dev/deepseek-v4-flash-0731",
			"kimchi-dev/glm-5.3-flash",
			"kimchi-dev/minimax-m3",
		])
	})

	it.each([
		{ models: [fallback, glm, primary], candidates: [primary, glm, fallback], missingRefs: [] },
		{ models: [fallback, glm], candidates: [glm, fallback], missingRefs: [primaryRef] },
		{ models: [fallback], candidates: [fallback], missingRefs: [primaryRef, glmRef] },
		{ models: [primary], candidates: [primary], missingRefs: [glmRef, fallbackRef] },
		{ models: [], candidates: [], missingRefs: [primaryRef, glmRef, fallbackRef] },
		{
			models: [createModel(primary.id, "custom"), createModel(glm.id, "custom"), createModel(fallback.id, "custom")],
			candidates: [],
			missingRefs: [primaryRef, glmRef, fallbackRef],
		},
	])("resolves ordered exact matches from $models", ({ models, candidates, missingRefs }) => {
		const registry = createModelRegistry(models)
		expect(resolveClassifierCandidates(registry)).toEqual({ candidates, missingRefs })
	})
})
