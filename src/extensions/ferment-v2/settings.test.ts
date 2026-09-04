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
	it("does not impose a total evaluator deadline by default", () => {
		expect(parseFermentV2Settings(undefined).evaluationTimeoutMs).toBeUndefined()
	})

	it("returns all defaults when the Ferment V2 value is not a plain object", () => {
		for (const value of [undefined, null, "fermentV2", ["not", "an", "object"]]) {
			expect(parseFermentV2Settings(value)).toEqual(DEFAULT_FERMENT_V2_SETTINGS)
		}
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

	it.each([
		{ field: "autoResume", invalid: ["true"], fallback: DEFAULT_FERMENT_V2_SETTINGS.autoResume },
		{
			field: "maxUnchangedContinuations",
			invalid: [0, 1.5, "3"],
			fallback: DEFAULT_FERMENT_V2_SETTINGS.maxUnchangedContinuations,
		},
		{
			field: "maxConsecutiveErrors",
			invalid: [0, 2.2, "5"],
			fallback: DEFAULT_FERMENT_V2_SETTINGS.maxConsecutiveErrors,
		},
		{ field: "defaultTokenBudget", invalid: [0, 1.5, "100000"], fallback: undefined },
		{
			field: "evaluationTimeoutMs",
			invalid: [0, 30_000.5, "30000"],
			fallback: DEFAULT_FERMENT_V2_SETTINGS.evaluationTimeoutMs,
		},
	] as const)("falls back for invalid $field values", ({ field, invalid, fallback }) => {
		for (const value of invalid) {
			expect(parseFermentV2Settings({ [field]: value })[field], `invalid ${field}: ${String(value)}`).toBe(fallback)
		}
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
