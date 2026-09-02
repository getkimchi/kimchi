import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testDir = join(tmpdir(), `kimchi-ferment-v2-settings-test-${process.pid}`)
const testPath = join(testDir, "settings.json")

vi.mock("../../config/json.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../config/json.js")>()
	return {
		...original,
		readJson: (_path: string) => original.readJson(testPath),
		writeJson: (_path: string, data: unknown) => original.writeJson(testPath, data),
	}
})

import { writeJson } from "../../config/json.js"
import { DEFAULT_FERMENT_V2_SETTINGS, getFermentV2Settings, parseFermentV2Settings } from "./settings.js"

function seed(data: Record<string, unknown>): void {
	writeJson(testPath, data)
}

beforeEach(() => {
	seed({})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("parseFermentV2Settings", () => {
	it("returns all defaults when raw is undefined", () => {
		expect(parseFermentV2Settings(undefined)).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})

	it("returns all defaults when raw is an empty object", () => {
		expect(parseFermentV2Settings({})).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})

	it.each([
		null,
		"fermentV2",
		42,
		true,
		["not", "an", "object"],
	])("returns all defaults when the Ferment V2 value itself is not a plain object (%p)", (value) => {
		expect(parseFermentV2Settings(value)).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})

	it("honours every field when all are valid", () => {
		expect(
			parseFermentV2Settings({
				autoResume: false,
				maxUnchangedContinuations: 5,
				maxConsecutiveErrors: 7,
				defaultTokenBudget: 250_000,
				evaluationTimeoutMs: 45_000,
			}),
		).toEqual({
			autoResume: false,
			maxUnchangedContinuations: 5,
			maxConsecutiveErrors: 7,
			defaultTokenBudget: 250_000,
			evaluationTimeoutMs: 45_000,
		})
	})

	describe("autoResume", () => {
		it.each([0, "true", null, undefined, {}])("falls back to the default for invalid value %p", (value) => {
			expect(parseFermentV2Settings({ autoResume: value }).autoResume).toBe(DEFAULT_FERMENT_V2_SETTINGS.autoResume)
		})

		it("accepts false explicitly", () => {
			expect(parseFermentV2Settings({ autoResume: false }).autoResume).toBe(false)
		})
	})

	describe("maxUnchangedContinuations", () => {
		it.each([0, -1, 1.5, "3", null, undefined])("falls back to the default for invalid value %p", (value) => {
			expect(parseFermentV2Settings({ maxUnchangedContinuations: value }).maxUnchangedContinuations).toBe(
				DEFAULT_FERMENT_V2_SETTINGS.maxUnchangedContinuations,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseFermentV2Settings({ maxUnchangedContinuations: 10 }).maxUnchangedContinuations).toBe(10)
		})
	})

	describe("maxConsecutiveErrors", () => {
		it.each([0, -3, 2.2, "5", null, undefined])("falls back to the default for invalid value %p", (value) => {
			expect(parseFermentV2Settings({ maxConsecutiveErrors: value }).maxConsecutiveErrors).toBe(
				DEFAULT_FERMENT_V2_SETTINGS.maxConsecutiveErrors,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseFermentV2Settings({ maxConsecutiveErrors: 8 }).maxConsecutiveErrors).toBe(8)
		})
	})

	describe("defaultTokenBudget", () => {
		it.each([0, -100, 1000.5, "100000", null])("falls back to unset for invalid value %p", (value) => {
			expect(parseFermentV2Settings({ defaultTokenBudget: value }).defaultTokenBudget).toBeUndefined()
		})

		it("stays unset when absent", () => {
			expect(parseFermentV2Settings({}).defaultTokenBudget).toBeUndefined()
		})

		it("accepts a positive integer", () => {
			expect(parseFermentV2Settings({ defaultTokenBudget: 200_000 }).defaultTokenBudget).toBe(200_000)
		})
	})

	describe("evaluationTimeoutMs", () => {
		it("defaults to 180 seconds", () => {
			expect(parseFermentV2Settings(undefined).evaluationTimeoutMs).toBe(180_000)
		})

		it.each([
			0,
			-30_000,
			30_000.5,
			"30000",
			null,
			undefined,
		])("falls back to the default for invalid value %p", (value) => {
			expect(parseFermentV2Settings({ evaluationTimeoutMs: value }).evaluationTimeoutMs).toBe(
				DEFAULT_FERMENT_V2_SETTINGS.evaluationTimeoutMs,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseFermentV2Settings({ evaluationTimeoutMs: 60_000 }).evaluationTimeoutMs).toBe(60_000)
		})
	})

	it("does not let one bad field poison the others", () => {
		const result = parseFermentV2Settings({
			autoResume: "not a boolean",
			maxUnchangedContinuations: 6,
			maxConsecutiveErrors: -1,
			defaultTokenBudget: 500_000,
			evaluationTimeoutMs: "not a number",
		})
		expect(result).toEqual({
			autoResume: DEFAULT_FERMENT_V2_SETTINGS.autoResume,
			maxUnchangedContinuations: 6,
			maxConsecutiveErrors: DEFAULT_FERMENT_V2_SETTINGS.maxConsecutiveErrors,
			defaultTokenBudget: 500_000,
			evaluationTimeoutMs: DEFAULT_FERMENT_V2_SETTINGS.evaluationTimeoutMs,
		})
	})
})

describe("getFermentV2Settings", () => {
	it("returns defaults when the Ferment V2 key is absent from settings.json", () => {
		seed({})
		expect(getFermentV2Settings()).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})

	it("reads the Ferment V2 key from settings.json", () => {
		seed({ fermentV2: { maxConsecutiveErrors: 9, autoResume: false } })
		expect(getFermentV2Settings()).toEqual({
			...DEFAULT_FERMENT_V2_SETTINGS,
			maxConsecutiveErrors: 9,
			autoResume: false,
		})
	})

	it("falls back to defaults when Ferment V2 is not an object", () => {
		seed({ fermentV2: "nonsense" })
		expect(getFermentV2Settings()).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})

	it("reads fresh on every call instead of caching a stale value", () => {
		seed({ fermentV2: { maxUnchangedContinuations: 4 } })
		expect(getFermentV2Settings().maxUnchangedContinuations).toBe(4)

		seed({ fermentV2: { maxUnchangedContinuations: 12 } })
		expect(getFermentV2Settings().maxUnchangedContinuations).toBe(12)
	})

	it("never throws even when settings.json is malformed", () => {
		writeJson(testPath, {}) // reset to valid JSON first
		const { writeFileSync } = require("node:fs")
		writeFileSync(testPath, "{ not valid json", "utf-8")
		expect(() => getFermentV2Settings()).not.toThrow()
		expect(getFermentV2Settings()).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
	})
})
