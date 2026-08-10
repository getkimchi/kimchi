import { describe, expect, it } from "vitest"
import { isCouncilVirtualModel, isCouncilVirtualModelRef } from "./model.js"

describe("Council virtual model identity", () => {
	it.each([
		"council-fast",
		"council",
		"council-deep",
		"kimchi/council-fast",
		"kimchi/council",
		"kimchi/council-deep",
		"kimchi-council",
		"kimchi-council/council",
	])("recognizes %s", (modelRef) => {
		expect(isCouncilVirtualModelRef(modelRef)).toBe(true)
	})

	it.each([
		"council-ai/model",
		"kimchi/councilor",
		"kimchi/council-extra",
		"other/council",
	])("does not overmatch %s", (modelRef) => {
		expect(isCouncilVirtualModelRef(modelRef)).toBe(false)
	})

	it("uses exact model metadata", () => {
		expect(isCouncilVirtualModel({ api: "custom", provider: "council-ai", id: "model" })).toBe(false)
		expect(isCouncilVirtualModel({ api: "kimchi-council", provider: "custom", id: "model" })).toBe(true)
	})
})
