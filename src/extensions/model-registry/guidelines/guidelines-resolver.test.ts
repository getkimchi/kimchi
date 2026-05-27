import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../index.js"
import { buildModelGuidelinesSection, resolveModelGuideline } from "./guidelines-resolver.js"

const ALL_KNOWN_IDS = [...MODEL_CAPABILITIES.keys()]

function fakeMetadata(slug: string): ModelMetadata {
	return {
		slug,
		display_name: "",
		provider: "ai-enabler",
		reasoning: false,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 131072, max_output_tokens: 16384 },
	}
}

const ALL_KNOWN_METADATA = ALL_KNOWN_IDS.map(fakeMetadata)

describe("resolveModelGuideline", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns empty string when no model is specified", () => {
		expect(resolveModelGuideline(undefined, registry)).toBe("")
	})

	it("returns composed guideline for minimax-m2.7", () => {
		const result = resolveModelGuideline("minimax-m2.7", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("web_search")
		expect(result).toContain("front-load")
	})

	it("returns composed guideline for kimi-k2.6", () => {
		const result = resolveModelGuideline("kimi-k2.6", registry)
		expect(result).toContain("Kimi family")
		expect(result).toContain("delegation sequence")
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("chunk")
	})

	it("returns empty string for ignored model kimi-k2.5", () => {
		expect(resolveModelGuideline("kimi-k2.5", registry)).toBe("")
	})

	it("returns empty string for ignored model claude-opus-4-6", () => {
		expect(resolveModelGuideline("claude-opus-4-6", registry)).toBe("")
	})

	it("returns composed guideline for nemotron-3-super-fp4", () => {
		const result = resolveModelGuideline("nemotron-3-super-fp4", registry)
		expect(result).toContain("Nemotron family")
		expect(result).toContain("long context window")
	})

	it("returns empty string for unknown model IDs", () => {
		expect(resolveModelGuideline("nonexistent-model", registry)).toBe("")
	})
})

describe("buildModelGuidelinesSection", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("builds section with content for minimax-m2.7", () => {
		const result = buildModelGuidelinesSection("minimax-m2.7", registry)
		expect(result).toContain("### Model Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("returns empty string when no model specified", () => {
		expect(buildModelGuidelinesSection(undefined, registry)).toBe("")
	})

	it("returns empty string for ignored models", () => {
		expect(buildModelGuidelinesSection("kimi-k2.5", registry)).toBe("")
	})

	it("contains no per-phase sections", () => {
		const result = buildModelGuidelinesSection("kimi-k2.6", registry)
		expect(result).not.toContain("Phase Guidelines")
		expect(result).not.toContain("During **build** phase")
		expect(result).not.toContain("During **explore** phase")
	})
})
