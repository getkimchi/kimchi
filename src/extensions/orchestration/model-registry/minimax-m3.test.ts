/**
 * Tests for the minimax-m3 registry entry:
 *   - present in MODEL_CAPABILITIES as "ignored"
 *   - excluded from auto-routing (not in DEFAULT_MODEL_ROLES pools)
 *   - does not emit warnings for ignored models
 */

import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { ModelRegistry } from "./model-registry.js"

function metadata(slug: string, overrides: Partial<ModelMetadata> = {}): ModelMetadata {
	return {
		slug,
		display_name: "",
		provider: "ai-enabler",
		reasoning: false,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 131072, max_output_tokens: 16384 },
		...overrides,
	}
}

describe("minimax-m3 registry entry", () => {
	it("is present in MODEL_CAPABILITIES", () => {
		expect(MODEL_CAPABILITIES.has("minimax-m3")).toBe(true)
	})

	it("is marked as 'ignored'", () => {
		expect(MODEL_CAPABILITIES.get("minimax-m3")).toBe("ignored")
	})

	it("is excluded from ModelRegistry.getAll() when the API returns it", () => {
		const registry = new ModelRegistry([metadata("minimax-m3")])
		expect(registry.getAll().map((m) => m.id)).not.toContain("minimax-m3")
	})

	it("is excluded from ModelRegistry.getModelsWithCapabilities()", () => {
		const registry = new ModelRegistry([metadata("minimax-m3")])
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).not.toContain("minimax-m3")
	})

	it("does not emit any warning for minimax-m3 (ignored = no warning)", () => {
		const registry = new ModelRegistry([metadata("minimax-m3")])
		expect(registry.warnings.find((w) => w.modelId === "minimax-m3")).toBeUndefined()
	})
})
