import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../index.js"
import {
	buildOrchestrationGuidelinesSection,
	buildPhaseGuidelinesSection,
	resolveOrchestrationGuideline,
	resolvePhaseGuideline,
} from "./guidelines-resolver.js"

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

describe("phase guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns default guideline when no model is specified", () => {
		const result = resolvePhaseGuideline("build", undefined, registry)
		expect(result).toContain("During **build** phase")
	})

	it("returns model-specific guideline when model has one", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("minimax-m2.7 specific")
		expect(result).toContain("mutex-based concurrency")
	})

	it("returns default guideline for phases with no model override", () => {
		const result = resolvePhaseGuideline("explore", "minimax-m2.7", registry)
		expect(result).toContain("During **explore** phase")
	})

	it("returns default guideline for unknown model IDs", () => {
		const result = resolvePhaseGuideline("plan", "nonexistent-model", registry)
		expect(result).toContain("During **plan** phase")
	})

	it("composes family and per-model layers for kimi-k2.6 plan", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Kimi family")
		expect(result).toContain("Chunks")
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("per-chunk acceptance criteria")
	})
})

describe("orchestration guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns empty string when no model is specified", () => {
		const result = resolveOrchestrationGuideline(undefined, registry)
		expect(result).toBe("")
	})

	it("returns composed orchestration guideline for minimax-m2.7", () => {
		const result = resolveOrchestrationGuideline("minimax-m2.7", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("web_search")
		expect(result).toContain("front-load")
	})

	it("returns composed orchestration guideline for kimi-k2.6", () => {
		const result = resolveOrchestrationGuideline("kimi-k2.6", registry)
		expect(result).toContain("Kimi family")
		expect(result).toContain("delegation sequence")
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("chunk")
	})

	it("returns empty string for ignored model kimi-k2.5", () => {
		const result = resolveOrchestrationGuideline("kimi-k2.5", registry)
		expect(result).toBe("")
	})

	it("returns empty string for ignored model claude-opus-4-6", () => {
		const result = resolveOrchestrationGuideline("claude-opus-4-6", registry)
		expect(result).toBe("")
	})

	it("returns composed orchestration guideline for nemotron-3-ultra-fp4", () => {
		const result = resolveOrchestrationGuideline("nemotron-3-ultra-fp4", registry)
		expect(result).toContain("Nemotron family")
		expect(result).toContain("long context window")
	})

	it("returns empty string for unknown model IDs", () => {
		const result = resolveOrchestrationGuideline("nonexistent-model", registry)
		expect(result).toBe("")
	})
})

describe("guideline section building", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("builds orchestration guidelines section with content", () => {
		const result = buildOrchestrationGuidelinesSection("minimax-m2.7", registry)
		expect(result).toContain("### Orchestration Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("returns empty string when no guidelines", () => {
		const result = buildOrchestrationGuidelinesSection(undefined, registry)
		expect(result).toBe("")
	})

	it("builds phase guidelines section with model content", () => {
		const result = buildPhaseGuidelinesSection("minimax-m2.7", "build", registry)
		expect(result).toContain("## Phase Guidelines (build)")
		expect(result).toContain("Outline-then-diff")
	})

	it("returns empty string when no phase", () => {
		const result = buildPhaseGuidelinesSection("minimax-m2.7", undefined, registry)
		expect(result).toBe("")
	})

	it("returns default guideline for phases with no model override", () => {
		const result = buildPhaseGuidelinesSection("minimax-m2.7", "explore", registry)
		expect(result).toContain("## Phase Guidelines (explore)")
		expect(result).toContain("During **explore** phase")
	})

	it("returns default guideline for unknown model", () => {
		const result = buildPhaseGuidelinesSection("nonexistent-model", "build", registry)
		expect(result).toContain("## Phase Guidelines (build)")
		expect(result).toContain("During **build** phase")
	})
})

describe("builtin-model guideline content", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("kimi-k2.5 build: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("build", "kimi-k2.5", registry)
		expect(result).toContain("During **build** phase")
	})

	it("kimi-k2.5 explore: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("explore", "kimi-k2.5", registry)
		expect(result).toContain("During **explore** phase")
	})

	it("kimi-k2.6 plan: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Chunks")
		expect(result).toContain("per-chunk acceptance criteria")
	})

	it("minimax-m2.7 build: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("mutex")
	})

	it("minimax-m2.7 review: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("review", "minimax-m2.7", registry)
		expect(result).toContain("scope creep")
		expect(result).toContain("hallucinated APIs")
		expect(result).toContain("inappropriate concurrency")
	})

	it("nemotron-3-ultra-fp4 explore: contains per-model layer", () => {
		const result = resolvePhaseGuideline("explore", "nemotron-3-ultra-fp4", registry)
		expect(result).toContain("1M token context window")
	})

	it("claude-opus-4-6 plan: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("plan", "claude-opus-4-6", registry)
		expect(result).toContain("During **plan** phase")
	})

	it("claude-opus-4-6 explore: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("explore", "claude-opus-4-6", registry)
		expect(result).toContain("During **explore** phase")
	})
})
