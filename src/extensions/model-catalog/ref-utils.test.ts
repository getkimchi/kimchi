import { describe, expect, it } from "vitest"
import { findModelByRef, modelIdFromRef, refFromModel, resolveModelRef, splitModelRef } from "./ref-utils.js"

describe("splitModelRef", () => {
	it("splits a plain provider/model ref", () => {
		expect(splitModelRef("kimchi-dev/kimi-k3")).toEqual({
			provider: "kimchi-dev",
			modelId: "kimi-k3",
		})
	})

	it("splits on the first slash: a sub-provider ref's remainder is the model id", () => {
		// The parse is ambiguous for sub-provider refs — doSetModel must
		// resolve them via findModelByRef, not via this split.
		expect(splitModelRef("kimchi-dev/anthropic/claude-opus-4-6")).toEqual({
			provider: "kimchi-dev",
			modelId: "anthropic/claude-opus-4-6",
		})
	})

	it("returns undefined for a slash-less ref", () => {
		expect(splitModelRef("kimi-k3")).toBeUndefined()
	})

	it("returns undefined when a part is empty", () => {
		expect(splitModelRef("/kimi-k3")).toBeUndefined()
		expect(splitModelRef("kimchi-dev/")).toBeUndefined()
	})
})

describe("modelIdFromRef", () => {
	it("returns everything after the first slash", () => {
		expect(modelIdFromRef("kimchi-dev/kimi-k3")).toBe("kimi-k3")
		expect(modelIdFromRef("provider/model/variant")).toBe("model/variant")
		expect(modelIdFromRef("kimi-k3")).toBe("kimi-k3")
	})
})

describe("resolveModelRef", () => {
	const registry = {
		getAvailable: () => [
			{ provider: "kimchi-dev/anthropic", id: "claude-opus-4-6" },
			{ provider: "kimchi-dev", id: "kimi-k3" },
		],
	}

	it("returns the model on a canonical-ref hit", () => {
		const result = resolveModelRef(registry as never, "kimchi-dev/anthropic/claude-opus-4-6")
		expect(result.model && refFromModel(result.model)).toBe("kimchi-dev/anthropic/claude-opus-4-6")
		expect(result.available).toBeUndefined()
	})

	it("returns sorted available refs on a miss", () => {
		const result = resolveModelRef(registry as never, "kimchi-dev/anthropic/claude-opus-4-5")
		expect(result.model).toBeUndefined()
		expect(result.available).toEqual(["kimchi-dev/anthropic/claude-opus-4-6", "kimchi-dev/kimi-k3"])
	})
})

describe("findModelByRef", () => {
	it("matches a sub-provider ref exactly, where splitModelRef cannot", () => {
		const registry = {
			getAvailable: () => [
				{ provider: "kimchi-dev/anthropic", id: "claude-opus-4-6" },
				{ provider: "kimchi-dev", id: "kimi-k3" },
			],
		}
		expect(findModelByRef(registry as never, "kimchi-dev/anthropic/claude-opus-4-6")?.id).toBe("claude-opus-4-6")
		expect(findModelByRef(registry as never, "kimchi-dev/anthropic/claude-opus-4-5")).toBeUndefined()
	})
})
