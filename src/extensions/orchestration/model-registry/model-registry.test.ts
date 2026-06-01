import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { ModelRegistry } from "./model-registry.js"
import type { ModelStrength, ModelTier } from "./types.js"

const ALLOWED_TIERS: ModelTier[] = ["light", "standard", "heavy"]
const ALLOWED_STRENGTHS: ModelStrength[] = ["build", "explore", "plan", "review", "research"]

const LIVE_ENTRIES = Object.entries(Object.fromEntries(MODEL_CAPABILITIES)).filter(
	([, value]) => value !== "ignored",
) as [string, Exclude<typeof MODEL_CAPABILITIES extends ReadonlyMap<string, infer V> ? V : never, "ignored">][]

describe("MODEL_CAPABILITIES completeness invariants", () => {
	it.each(LIVE_ENTRIES)("%s — description is a non-empty string", (_id, cap) => {
		expect(typeof cap.description).toBe("string")
		expect(cap.description.trim().length).toBeGreaterThan(0)
	})

	it.each(LIVE_ENTRIES)("%s — tier is one of light | standard | heavy", (_id, cap) => {
		expect(ALLOWED_TIERS).toContain(cap.tier)
	})

	it.each(LIVE_ENTRIES)("%s — strengths is a non-empty array of valid ModelStrength values", (_id, cap) => {
		expect(Array.isArray(cap.strengths)).toBe(true)
		expect(cap.strengths.length).toBeGreaterThanOrEqual(1)
		for (const s of cap.strengths) {
			expect(ALLOWED_STRENGTHS).toContain(s)
		}
	})

	it.each(LIVE_ENTRIES)("%s — orchestrationGuidelines is a non-empty string", (_id, cap) => {
		expect(typeof cap.orchestrationGuidelines).toBe("string")
		expect((cap.orchestrationGuidelines as string).trim().length).toBeGreaterThan(0)
	})

	it.each(LIVE_ENTRIES)("%s — every declared strength phase has a non-empty guidelines entry", (_id, cap) => {
		for (const strength of cap.strengths) {
			const guidelineValue = cap.guidelines?.[strength]
			expect(
				guidelineValue,
				`guidelines["${strength}"] must be a non-empty string (strength declared in strengths[])`,
			).toBeTruthy()
			expect(typeof guidelineValue).toBe("string")
			expect((guidelineValue as string).trim().length).toBeGreaterThan(0)
		}
	})
})

const KNOWN_IDS = [...MODEL_CAPABILITIES.keys()]
const ACTIVE_IDS = KNOWN_IDS.filter((id) => MODEL_CAPABILITIES.get(id) !== "ignored")

function metadata(
	slug: string,
	overrides: Partial<ModelMetadata> & { status?: ModelMetadata["status"]; replacement?: string } = {},
): ModelMetadata {
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

const KNOWN_METADATA = KNOWN_IDS.map((id) => metadata(id))
const ACTIVE_METADATA = ACTIVE_IDS.map((id) => metadata(id))

describe("ModelRegistry — known models only", () => {
	it("returns all active (non-ignored) models when all are available in the API", () => {
		const registry = new ModelRegistry(KNOWN_METADATA)
		expect(registry.getAll()).toHaveLength(ACTIVE_METADATA.length)
		expect(registry.getModelsWithCapabilities()).toHaveLength(ACTIVE_METADATA.length)
		expect(registry.warnings).toHaveLength(0)
	})

	it("getAll() preserves the API order, excluding ignored models", () => {
		const reversed = [...KNOWN_METADATA].reverse()
		const registry = new ModelRegistry(reversed)
		expect(registry.getAll().map((m) => m.id)).toEqual([...ACTIVE_IDS].reverse())
	})

	it("every known model has a non-placeholder description", () => {
		const registry = new ModelRegistry(KNOWN_METADATA)
		for (const model of registry.getModelsWithCapabilities()) {
			expect(model.capabilities.description).not.toBe("TODO")
			expect(model.capabilities.description.length).toBeGreaterThan(50)
		}
	})

	it("uses display_name from metadata when non-empty", () => {
		const id = ACTIVE_IDS[0]
		const registry = new ModelRegistry([metadata(id, { display_name: "Custom Label" })])
		expect(registry.getAll()[0].name).toBe("Custom Label")
	})

	it("falls back to derived name when display_name is empty", () => {
		const id = ACTIVE_IDS[0]
		const registry = new ModelRegistry([metadata(id, { display_name: "" })])
		expect(registry.getAll()[0].name.length).toBeGreaterThan(0)
	})
})

describe("ModelRegistry — unknown model in API", () => {
	it("includes the unknown model in getAll() with a generic descriptor", () => {
		const registry = new ModelRegistry([...KNOWN_METADATA, metadata("brand-new-model")])
		const unknown = registry.getAll().find((m) => m.id === "brand-new-model")
		expect(unknown).toBeDefined()
		expect(unknown?.capabilities.description).toContain("No capability information")
	})

	it("emits a warning for the unknown model", () => {
		const registry = new ModelRegistry([...KNOWN_METADATA, metadata("brand-new-model")])
		const warning = registry.warnings.find((w) => w.modelId === "brand-new-model")
		expect(warning).toBeDefined()
		expect(warning?.modelId).toBe("brand-new-model")
	})

	it("excludes the unknown model from getModelsWithCapabilities()", () => {
		const registry = new ModelRegistry([...KNOWN_METADATA, metadata("brand-new-model")])
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).not.toContain("brand-new-model")
	})

	it("emits an unknown_model warning", () => {
		const registry = new ModelRegistry([...KNOWN_METADATA, metadata("brand-new-model")])
		const warning = registry.warnings.find((w) => w.modelId === "brand-new-model")
		expect(warning).toBeDefined()
		expect(warning?.kind).toBe("unknown_model")
	})
})

describe("ModelRegistry — orphaned capability entry", () => {
	it("excludes the orphaned model from both getAll() and getModelsWithCapabilities()", () => {
		const presentId = ACTIVE_IDS[0]
		const registry = new ModelRegistry([metadata(presentId)])
		expect(registry.getAll().map((m) => m.id)).toEqual([presentId])
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).toEqual([presentId])
	})

	it("does not emit any warning for capability entries absent from the API", () => {
		const presentId = ACTIVE_IDS[0]
		const registry = new ModelRegistry([metadata(presentId)])
		expect(registry.warnings).toHaveLength(0)
	})
})

describe("ModelRegistry — ignored models", () => {
	it("excludes ignored models from getAll() and getModelsWithCapabilities()", () => {
		const ignoredIds = KNOWN_IDS.filter((id) => MODEL_CAPABILITIES.get(id) === "ignored")
		const registry = new ModelRegistry(ignoredIds.map((id) => metadata(id)))
		expect(registry.getAll()).toHaveLength(0)
		expect(registry.getModelsWithCapabilities()).toHaveLength(0)
	})

	it("does not emit warnings for ignored models", () => {
		const ignoredIds = KNOWN_IDS.filter((id) => MODEL_CAPABILITIES.get(id) === "ignored")
		const registry = new ModelRegistry(ignoredIds.map((id) => metadata(id)))
		expect(registry.warnings).toHaveLength(0)
	})
})

describe("ModelRegistry — sunset models", () => {
	it("excludes sunset models from getAll() and getModelsWithCapabilities()", () => {
		const registry = new ModelRegistry([metadata("some-model", { status: "sunset" })])
		expect(registry.getAll()).toHaveLength(0)
		expect(registry.getModelsWithCapabilities()).toHaveLength(0)
	})

	it("does not emit warnings for sunset models", () => {
		const registry = new ModelRegistry([metadata("some-model", { status: "sunset" })])
		expect(registry.warnings).toHaveLength(0)
	})

	it("sunset model is excluded even when it has a capabilities entry", () => {
		const registry = new ModelRegistry([metadata(ACTIVE_IDS[0], { status: "sunset" })])
		expect(registry.getAll().map((m) => m.id)).not.toContain(ACTIVE_IDS[0])
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).not.toContain(ACTIVE_IDS[0])
		expect(registry.warnings).toHaveLength(0)
	})
})

describe("ModelRegistry — deprecated models", () => {
	it("includes deprecated models in getAll()", () => {
		const registry = new ModelRegistry([metadata("some-model", { status: "deprecated" })])
		expect(registry.getAll().map((m) => m.id)).toContain("some-model")
	})

	it("emits a deprecated_model warning with modelId", () => {
		const registry = new ModelRegistry([metadata("some-model", { status: "deprecated" })])
		const warning = registry.warnings.find((w) => w.modelId === "some-model")
		expect(warning).toBeDefined()
		expect(warning?.kind).toBe("deprecated_model")
	})

	it("emits deprecated_model warning with replacement when provided", () => {
		const registry = new ModelRegistry([metadata("old-model", { status: "deprecated", replacement: "new-model" })])
		const warning = registry.warnings.find((w) => w.modelId === "old-model")
		expect(warning?.kind).toBe("deprecated_model")
		expect(warning?.replacement).toBe("new-model")
	})

	it("deprecated model without replacement emits warning with undefined replacement", () => {
		const registry = new ModelRegistry([metadata("old-model", { status: "deprecated" })])
		const warning = registry.warnings.find((w) => w.modelId === "old-model")
		expect(warning?.kind).toBe("deprecated_model")
		expect(warning?.replacement).toBeUndefined()
	})

	it("deprecated model with capabilities uses those capabilities", () => {
		const id = ACTIVE_IDS[0]
		const registry = new ModelRegistry([metadata(id, { status: "deprecated" })])
		const model = registry.getAll().find((m) => m.id === id)
		const entry = MODEL_CAPABILITIES.get(id)
		if (!entry || entry === "ignored") return
		expect(model?.capabilities.description).toBe(entry.description)
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).toContain(id)
	})

	it("deprecated model without capabilities uses generic capabilities", () => {
		const registry = new ModelRegistry([metadata("unknown-deprecated", { status: "deprecated" })])
		const model = registry.getAll().find((m) => m.id === "unknown-deprecated")
		expect(model?.capabilities.description).toContain("No capability information")
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).not.toContain("unknown-deprecated")
	})
})

describe("ModelRegistry — getModelsWithCapabilities()", () => {
	it("is the intersection of API models and capability map, excluding ignored", () => {
		const registry = new ModelRegistry([...KNOWN_METADATA, metadata("unknown-extra")])
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).toEqual(expect.arrayContaining(ACTIVE_IDS))
		expect(registry.getModelsWithCapabilities().map((m) => m.id)).not.toContain("unknown-extra")
	})

	it("returns empty when API list is empty", () => {
		const registry = new ModelRegistry([])
		expect(registry.getModelsWithCapabilities()).toHaveLength(0)
	})
})
