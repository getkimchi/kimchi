// Unit tests for the ACP per-message model attribution contract: ref
// composition from the assistant message tuple (requested vs served ids) and
// the first-chunk-per-messageId dedup that keeps `_meta` off repeated chunks.
// The wire contract itself (payload keys, refs, last-wins rule) is documented
// in docs/acp-model-attribution.md.

import type { AssistantMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { CAPABILITIES_KEY } from "./capabilities.js"
import { type ModelAttribution, modelAttributionFrom, modelMetaFor } from "./model-attribution.js"

function message(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "kimchi-dev",
		model: "glm-5.3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...fields,
	}
}

describe("modelAttributionFrom", () => {
	it("composes the served ref from responseModel and the requested ref from model when routed", () => {
		expect(modelAttributionFrom(message({ model: "auto", responseModel: "glm-5.3" }))).toEqual({
			modelId: "kimchi-dev/glm-5.3",
			requestedModelId: "kimchi-dev/auto",
		})
	})

	it("falls back to the requested id for the served ref when no responseModel was reported", () => {
		expect(modelAttributionFrom(message({ model: "glm-5.3" }))).toEqual({
			modelId: "kimchi-dev/glm-5.3",
			requestedModelId: "kimchi-dev/glm-5.3",
		})
	})

	it("treats responseModel equal to model as the pinned case (identical refs)", () => {
		expect(modelAttributionFrom(message({ model: "glm-5.3", responseModel: "glm-5.3" }))).toEqual({
			modelId: "kimchi-dev/glm-5.3",
			requestedModelId: "kimchi-dev/glm-5.3",
		})
	})

	it("keeps a raw unknown responseModel in the served ref so clients see the backend's id", () => {
		expect(modelAttributionFrom(message({ model: "auto", responseModel: "brand-new-backend-model" }))).toEqual({
			modelId: "kimchi-dev/brand-new-backend-model",
			requestedModelId: "kimchi-dev/auto",
		})
	})
})

describe("modelMetaFor", () => {
	const routed: ModelAttribution = { modelId: "kimchi-dev/glm-5.3", requestedModelId: "kimchi-dev/auto" }

	it("attaches _meta on the first chunk seen for a messageId and records it", () => {
		const seen = new Map<string, ModelAttribution>()
		expect(modelMetaFor(seen, "km.0", routed)).toEqual({ [CAPABILITIES_KEY]: routed })
		expect(seen.get("km.0")).toEqual(routed)
	})

	it("returns undefined for a later chunk whose attribution is unchanged", () => {
		const seen = new Map<string, ModelAttribution>()
		modelMetaFor(seen, "km.0", routed)
		expect(modelMetaFor(seen, "km.0", routed)).toBeUndefined()
	})

	it("re-attaches when the attribution changes for the same messageId and updates the record", () => {
		const seen = new Map<string, ModelAttribution>()
		modelMetaFor(seen, "km.0", routed)
		const corrected: ModelAttribution = { modelId: "kimchi-dev/kimi-k3", requestedModelId: "kimchi-dev/auto" }
		expect(modelMetaFor(seen, "km.0", corrected)).toEqual({ [CAPABILITIES_KEY]: corrected })
		expect(seen.get("km.0")).toEqual(corrected)
	})

	it("tracks messageIds independently", () => {
		const seen = new Map<string, ModelAttribution>()
		modelMetaFor(seen, "km.0", routed)
		const pinned: ModelAttribution = { modelId: "kimchi-dev/glm-5.3", requestedModelId: "kimchi-dev/glm-5.3" }
		expect(modelMetaFor(seen, "km.1", pinned)).toEqual({ [CAPABILITIES_KEY]: pinned })
	})

	it("always attaches when it cannot dedup — no messageId or no seen-map", () => {
		expect(modelMetaFor(new Map(), undefined, routed)).toEqual({ [CAPABILITIES_KEY]: routed })
		expect(modelMetaFor(undefined, "km.0", routed)).toEqual({ [CAPABILITIES_KEY]: routed })
	})
})
