import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	type ModelCustomMetadata,
	deleteModelMetadata,
	getModelMetadata,
	getModelMetadataWarnings,
	isModelMetadataMissing,
	loadModelMetadata,
	resetModelMetadataCache,
	resolveModelMetadata,
	saveModelMetadata,
} from "./model-metadata.js"

afterEach(() => {
	resetModelMetadataCache()
})

describe("loadModelMetadata", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("returns empty map when settings file absent", () => {
		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(0)
		expect(result.warnings).toEqual([])
	})

	it("reads metadata from settings.json", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"custom/model-1": { tier: "heavy", description: "A heavy model", vision: true },
						"custom/model-2": { tier: "light" },
					},
				},
				null,
				2,
			),
		)

		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(2)
		expect(result.metadata.get("custom/model-1")).toEqual({
			tier: "heavy",
			description: "A heavy model",
			vision: true,
		})
		expect(result.metadata.get("custom/model-2")).toEqual({ tier: "light" })
		expect(result.warnings).toEqual([])
	})

	it("ignores entries with no valid fields", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"valid/model": { tier: "standard" },
						"empty/model": {},
						"invalid/model": { unknownField: "test" },
						"null/model": null,
					},
				},
				null,
				2,
			),
		)

		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(1)
		expect(result.metadata.has("valid/model")).toBe(true)
		expect(result.metadata.has("empty/model")).toBe(false)
		expect(result.metadata.has("invalid/model")).toBe(false)
		expect(result.metadata.has("null/model")).toBe(false)
	})

	it("ignores non-object modelMetadata value", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ modelMetadata: "not an object" }, null, 2))

		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(0)
	})

	it("ignores array modelMetadata value", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ modelMetadata: [] }, null, 2))

		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(0)
	})

	it("trims whitespace from ref keys", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"  custom/model-1  ": { tier: "heavy" },
						"custom/model-2": { tier: "light" },
					},
				},
				null,
				2,
			),
		)

		const result = loadModelMetadata(testPath)
		expect(result.metadata.get("custom/model-1")).toEqual({ tier: "heavy" })
		// Note: whitespace trimming happens on the key itself, not the value
		// So "  custom/model-1  " becomes "custom/model-1" (trims leading/trailing)
		expect(result.metadata.has("  custom/model-1  ")).toBe(false)
	})

	it("validates tier values strictly", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"valid/model": { tier: "standard" },
						"invalid/tier": { tier: "not-a-tier" },
					},
				},
				null,
				2,
			),
		)

		const result = loadModelMetadata(testPath)
		expect(result.metadata.get("valid/model")?.tier).toBe("standard")
		// Invalid tier now drops the entire entry (and surfaces a warning),
		// rather than silently dropping just the tier field. Either way the
		// resolved tier is undefined — the contract tests assert.
		expect(result.metadata.get("invalid/tier")?.tier).toBeUndefined()
	})

	it("emits warnings for entries that fail TypeBox validation", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"bad/tier": { tier: "not-a-tier" },
						"bad/description": { description: 123 },
						"bad/vision": { vision: "yes" },
					},
				},
				null,
				2,
			),
		)

		const result = loadModelMetadata(testPath)
		expect(result.metadata.size).toBe(0)
		const refs = result.warnings.map((w) => w.ref).sort()
		expect(refs).toEqual(["bad/description", "bad/tier", "bad/vision"])
		for (const w of result.warnings) {
			expect(w.message).toMatch(/entry failed validation/)
		}
	})

	it("does not warn for null/non-object entries (cannot arise from well-behaved callers)", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify({
				modelMetadata: {
					"null/model": null,
					"string/model": "not-an-object",
					"array/model": [],
				},
			}),
		)

		const result = loadModelMetadata(testPath)
		expect(result.warnings).toEqual([])
	})
})

describe("saveModelMetadata", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("creates file and directory if absent", () => {
		const metadata = new Map<string, ModelCustomMetadata>([["custom/model", { tier: "heavy" }]])
		saveModelMetadata(metadata, testPath)
		expect(existsSync(testPath)).toBe(true)
	})

	it("writes to modelMetadata key", () => {
		const metadata = new Map<string, ModelCustomMetadata>([
			["custom/model", { tier: "heavy", description: "Test model", vision: true }],
		])
		saveModelMetadata(metadata, testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata).toBeDefined()
		expect(saved.modelMetadata["custom/model"]).toEqual({
			tier: "heavy",
			description: "Test model",
			vision: true,
		})
	})

	it("removes modelMetadata key when map is empty", () => {
		// First save some data
		const metadata = new Map<string, ModelCustomMetadata>([["custom/model", { tier: "heavy" }]])
		saveModelMetadata(metadata, testPath)
		expect(existsSync(testPath)).toBe(true)

		// Then save empty map
		saveModelMetadata(new Map(), testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata).toBeUndefined()
	})

	it("preserves other settings in the file", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ multiModel: true, theme: "dark", otherSetting: 42 }, null, 2))

		const metadata = new Map<string, ModelCustomMetadata>([["custom/model", { tier: "heavy", description: "Test" }]])
		saveModelMetadata(metadata, testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.multiModel).toBe(true)
		expect(saved.theme).toBe("dark")
		expect(saved.otherSetting).toBe(42)
		expect(saved.modelMetadata["custom/model"]).toEqual({ tier: "heavy", description: "Test" })
	})

	it("merges new metadata with existing modelMetadata", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"old/model": { tier: "light" },
						"another/old": { description: "Old description" },
					},
				},
				null,
				2,
			),
		)

		const metadata = new Map<string, ModelCustomMetadata>([["new/model", { tier: "heavy" }]])
		saveModelMetadata(metadata, testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata["old/model"]).toEqual({ tier: "light" })
		expect(saved.modelMetadata["another/old"]).toEqual({ description: "Old description" })
		expect(saved.modelMetadata["new/model"]).toEqual({ tier: "heavy" })
	})

	it("overwriting a model updates it while keeping others", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"model/a": { tier: "light" },
						"model/b": { tier: "standard" },
					},
				},
				null,
				2,
			),
		)

		const metadata = new Map<string, ModelCustomMetadata>([["model/a", { tier: "heavy", description: "Updated" }]])
		saveModelMetadata(metadata, testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata["model/a"]).toEqual({ tier: "heavy", description: "Updated" })
		expect(saved.modelMetadata["model/b"]).toEqual({ tier: "standard" })
	})

	// Regression: previously saveModelMetadata caught JSON.parse errors
	// indiscriminately and would overwrite a corrupted settings.json with {}
	// + only the new modelMetadata, destroying the user's other settings.
	// A corrupted file must surface the error instead.
	it("throws when settings.json contains malformed JSON", () => {
		mkdirSync(testDir, { recursive: true })
		const corrupted = "{ this is not valid json :::"
		writeFileSync(testPath, corrupted)

		const metadata = new Map<string, ModelCustomMetadata>([["custom/model", { tier: "heavy" }]])
		expect(() => saveModelMetadata(metadata, testPath)).toThrow()

		// The file must be left untouched — silent overwrite is the bug.
		expect(readFileSync(testPath, "utf-8")).toBe(corrupted)
	})

	it("does not throw when settings.json is absent", () => {
		// ENOENT is the only acceptable swallowed error.
		const metadata = new Map<string, ModelCustomMetadata>([["custom/model", { tier: "heavy" }]])
		expect(() => saveModelMetadata(metadata, testPath)).not.toThrow()
		expect(existsSync(testPath)).toBe(true)
	})
})

describe("deleteModelMetadata", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("removes a single model entry", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify({
				modelMetadata: {
					"custom/model-a": { tier: "heavy" },
					"custom/model-b": { tier: "light" },
				},
			}),
		)

		deleteModelMetadata("custom/model-a", testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata["custom/model-a"]).toBeUndefined()
		expect(saved.modelMetadata["custom/model-b"]).toEqual({ tier: "light" })
	})

	it("removes modelMetadata key when last entry is deleted", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify({
				otherSetting: true,
				modelMetadata: { "custom/only-model": { tier: "standard" } },
			}),
		)

		deleteModelMetadata("custom/only-model", testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata).toBeUndefined()
		expect(saved.otherSetting).toBe(true)
	})

	it("is a no-op when model ref does not exist", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify({
				modelMetadata: { "custom/model": { tier: "heavy" } },
			}),
		)

		deleteModelMetadata("custom/nonexistent", testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata["custom/model"]).toEqual({ tier: "heavy" })
	})

	it("is a no-op when settings file does not exist", () => {
		deleteModelMetadata("custom/model", testPath)
		expect(existsSync(testPath)).toBe(false)
	})

	it("is a no-op when modelMetadata key is absent", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(testPath, JSON.stringify({ otherSetting: true }))

		deleteModelMetadata("custom/model", testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata).toBeUndefined()
		expect(saved.otherSetting).toBe(true)
	})

	it("invalidates the metadata cache", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify({
				modelMetadata: { "custom/model": { tier: "heavy" } },
			}),
		)

		const before = getModelMetadata(testPath)
		expect(before.get("custom/model")).toEqual({ tier: "heavy" })

		deleteModelMetadata("custom/model", testPath)

		const after = getModelMetadata(testPath)
		expect(after.has("custom/model")).toBe(false)
	})
})

describe("resolveModelMetadata", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("returns builtin for known model (e.g. kimchi-dev/kimi-k2.6)", () => {
		const result = resolveModelMetadata("kimchi-dev/kimi-k2.6", testPath)
		expect(result).toEqual(expect.objectContaining({ source: "builtin", tier: "heavy", vision: true }))
	})

	it("returns builtin for known model without provider prefix", () => {
		const result = resolveModelMetadata("kimi-k2.6", testPath)
		expect(result).toEqual(expect.objectContaining({ source: "builtin", tier: "heavy" }))
	})

	it("returns custom for model in settings", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"custom/my-model": { tier: "standard", description: "My custom model", vision: false },
					},
				},
				null,
				2,
			),
		)

		const loaded = loadModelMetadata(testPath)
		expect(loaded.metadata.get("custom/my-model")).toEqual({
			tier: "standard",
			description: "My custom model",
			vision: false,
		})

		const result = resolveModelMetadata("custom/my-model", testPath)
		expect(result).toEqual({
			source: "custom",
			tier: "standard",
			description: "My custom model",
			vision: false,
		})
	})

	it("returns undefined for unknown model with no custom metadata", () => {
		const result = resolveModelMetadata("unknown/provider-model", testPath)
		expect(result).toBeUndefined()
	})

	it("prefers custom over builtin when both exist", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"kimchi-dev/kimi-k2.6": { tier: "light", description: "Custom override" },
					},
				},
				null,
				2,
			),
		)

		const result = resolveModelMetadata("kimchi-dev/kimi-k2.6", testPath)
		expect(result).toEqual(expect.objectContaining({ source: "custom", tier: "light", description: "Custom override" }))
	})

	it("returns builtin for minimax-m2.7", () => {
		const result = resolveModelMetadata("kimchi-dev/minimax-m2.7", testPath)
		expect(result).toEqual(expect.objectContaining({ source: "builtin", tier: "standard", vision: false }))
	})

	it("returns builtin for nemotron-3-ultra-fp4", () => {
		const result = resolveModelMetadata("kimchi-dev/nemotron-3-ultra-fp4", testPath)
		expect(result).toEqual(expect.objectContaining({ source: "builtin", tier: "light" }))
	})
})

describe("isModelMetadataMissing", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("returns false for known builtin model", () => {
		expect(isModelMetadataMissing("kimchi-dev/kimi-k2.6", testPath)).toBe(false)
		expect(isModelMetadataMissing("kimchi-dev/minimax-m2.7", testPath)).toBe(false)
	})

	it("returns true for completely unknown model with no custom metadata", () => {
		expect(isModelMetadataMissing("completely/unknown-model-xyz", testPath)).toBe(true)
	})

	it("returns false when custom metadata exists for a model", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"custom/my-model": { tier: "standard" },
					},
				},
				null,
				2,
			),
		)

		getModelMetadata(testPath)
		expect(isModelMetadataMissing("custom/my-model", testPath)).toBe(false)
	})
})

describe("Cache functions", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		resetModelMetadataCache()
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("getModelMetadata returns cached data", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"cached/model": { tier: "heavy" },
					},
				},
				null,
				2,
			),
		)

		// First call loads from disk at the test path
		const first = getModelMetadata(testPath)
		expect(first.get("cached/model")).toEqual({ tier: "heavy" })

		// Modify the file on disk
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"cached/model": { tier: "light" },
						"new/model": { tier: "standard" },
					},
				},
				null,
				2,
			),
		)

		// Second call with same path should return cached data, not the new file content
		const second = getModelMetadata(testPath)
		expect(second.get("cached/model")).toEqual({ tier: "heavy" })
		expect(second.has("new/model")).toBe(false)
	})

	it("resetModelMetadataCache clears the cache", () => {
		mkdirSync(testDir, { recursive: true })
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"test/model": { tier: "heavy" },
					},
				},
				null,
				2,
			),
		)

		// Load and cache
		const first = getModelMetadata(testPath)
		expect(first.get("test/model")).toEqual({ tier: "heavy" })

		// Modify file
		writeFileSync(
			testPath,
			JSON.stringify(
				{
					modelMetadata: {
						"test/model": { tier: "light" },
						"new/model": { tier: "standard" },
					},
				},
				null,
				2,
			),
		)

		// Reset cache
		resetModelMetadataCache()

		// Next call should re-read from disk
		const afterReset = getModelMetadata(testPath)
		expect(afterReset.get("test/model")).toEqual({ tier: "light" })
		expect(afterReset.get("new/model")).toEqual({ tier: "standard" })
	})

	it("getModelMetadataWarnings returns empty array initially", () => {
		const warnings = getModelMetadataWarnings()
		expect(warnings).toEqual([])
	})
})

describe("Integration: saveModelMetadata and loadModelMetadata round-trip", () => {
	const testDir = join(tmpdir(), `kimchi-model-metadata-test-${process.pid}`)
	const testPath = join(testDir, "settings.json")

	afterEach(() => {
		resetModelMetadataCache()
		try {
			rmSync(testDir, { recursive: true, force: true })
		} catch {}
	})

	it("round-trips a complex metadata map correctly", () => {
		const original = new Map<string, ModelCustomMetadata>([
			["custom/model-1", { tier: "heavy", description: "Heavy model", vision: true }],
			["custom/model-2", { tier: "light" }],
			["custom/model-3", { description: "Description only" }],
			["custom/model-4", { vision: false }],
		])

		saveModelMetadata(original, testPath)
		const loaded = loadModelMetadata(testPath)

		expect(loaded.metadata.size).toBe(4)
		expect(loaded.metadata.get("custom/model-1")).toEqual({ tier: "heavy", description: "Heavy model", vision: true })
		expect(loaded.metadata.get("custom/model-2")).toEqual({ tier: "light" })
		expect(loaded.metadata.get("custom/model-3")).toEqual({ description: "Description only" })
		expect(loaded.metadata.get("custom/model-4")).toEqual({ vision: false })
	})

	it("empty map removes modelMetadata from settings", () => {
		const metadata = new Map<string, ModelCustomMetadata>([["temp/model", { tier: "standard" }]])
		saveModelMetadata(metadata, testPath)
		expect(existsSync(testPath)).toBe(true)

		saveModelMetadata(new Map(), testPath)

		const saved = JSON.parse(readFileSync(testPath, "utf-8"))
		expect(saved.modelMetadata).toBeUndefined()
	})
})
