import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Monkey-patch the json layer so readJson/writeJson -- called by the real
// readConfigSetting -- redirect to a per-test temp file instead of the real
// ~/.config/kimchi/harness/settings.json. settings.ts's own logic runs
// unmodified. Same pattern as config/settings.test.ts and
// orchestration/model-roles.test.ts.
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `kimchi-goal-settings-test-${process.pid}`)
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
import { DEFAULT_GOAL_SETTINGS, getGoalSettings, parseGoalSettings } from "./settings.js"

function seed(data: Record<string, unknown>): void {
	writeJson(testPath, data)
}

beforeEach(() => {
	seed({})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("parseGoalSettings", () => {
	it("returns all defaults when raw is undefined", () => {
		expect(parseGoalSettings(undefined)).toEqual(DEFAULT_GOAL_SETTINGS)
	})

	it("returns all defaults when raw is an empty object", () => {
		expect(parseGoalSettings({})).toEqual(DEFAULT_GOAL_SETTINGS)
	})

	it.each([
		null,
		"goal",
		42,
		true,
		["not", "an", "object"],
	])("returns all defaults when the goal value itself is not a plain object (%p)", (value) => {
		expect(parseGoalSettings(value)).toEqual(DEFAULT_GOAL_SETTINGS)
	})

	it("honours every field when all are valid", () => {
		expect(
			parseGoalSettings({
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
			expect(parseGoalSettings({ autoResume: value }).autoResume).toBe(DEFAULT_GOAL_SETTINGS.autoResume)
		})

		it("accepts false explicitly", () => {
			expect(parseGoalSettings({ autoResume: false }).autoResume).toBe(false)
		})
	})

	describe("maxUnchangedContinuations", () => {
		it.each([0, -1, 1.5, "3", null, undefined])("falls back to the default for invalid value %p", (value) => {
			expect(parseGoalSettings({ maxUnchangedContinuations: value }).maxUnchangedContinuations).toBe(
				DEFAULT_GOAL_SETTINGS.maxUnchangedContinuations,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseGoalSettings({ maxUnchangedContinuations: 10 }).maxUnchangedContinuations).toBe(10)
		})
	})

	describe("maxConsecutiveErrors", () => {
		it.each([0, -3, 2.2, "5", null, undefined])("falls back to the default for invalid value %p", (value) => {
			expect(parseGoalSettings({ maxConsecutiveErrors: value }).maxConsecutiveErrors).toBe(
				DEFAULT_GOAL_SETTINGS.maxConsecutiveErrors,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseGoalSettings({ maxConsecutiveErrors: 8 }).maxConsecutiveErrors).toBe(8)
		})
	})

	describe("defaultTokenBudget", () => {
		it.each([0, -100, 1000.5, "100000", null])("falls back to unset for invalid value %p", (value) => {
			expect(parseGoalSettings({ defaultTokenBudget: value }).defaultTokenBudget).toBeUndefined()
		})

		it("stays unset when absent", () => {
			expect(parseGoalSettings({}).defaultTokenBudget).toBeUndefined()
		})

		it("accepts a positive integer", () => {
			expect(parseGoalSettings({ defaultTokenBudget: 200_000 }).defaultTokenBudget).toBe(200_000)
		})
	})

	describe("evaluationTimeoutMs", () => {
		it.each([
			0,
			-30_000,
			30_000.5,
			"30000",
			null,
			undefined,
		])("falls back to the default for invalid value %p", (value) => {
			expect(parseGoalSettings({ evaluationTimeoutMs: value }).evaluationTimeoutMs).toBe(
				DEFAULT_GOAL_SETTINGS.evaluationTimeoutMs,
			)
		})

		it("accepts a positive integer", () => {
			expect(parseGoalSettings({ evaluationTimeoutMs: 60_000 }).evaluationTimeoutMs).toBe(60_000)
		})
	})

	it("does not let one bad field poison the others", () => {
		const result = parseGoalSettings({
			autoResume: "not a boolean",
			maxUnchangedContinuations: 6,
			maxConsecutiveErrors: -1,
			defaultTokenBudget: 500_000,
			evaluationTimeoutMs: "not a number",
		})
		expect(result).toEqual({
			autoResume: DEFAULT_GOAL_SETTINGS.autoResume,
			maxUnchangedContinuations: 6,
			maxConsecutiveErrors: DEFAULT_GOAL_SETTINGS.maxConsecutiveErrors,
			defaultTokenBudget: 500_000,
			evaluationTimeoutMs: DEFAULT_GOAL_SETTINGS.evaluationTimeoutMs,
		})
	})
})

describe("getGoalSettings", () => {
	it("returns defaults when the goal key is absent from settings.json", () => {
		seed({})
		expect(getGoalSettings()).toEqual(DEFAULT_GOAL_SETTINGS)
	})

	it("reads the goal key from settings.json", () => {
		seed({ goal: { maxConsecutiveErrors: 9, autoResume: false } })
		expect(getGoalSettings()).toEqual({
			...DEFAULT_GOAL_SETTINGS,
			maxConsecutiveErrors: 9,
			autoResume: false,
		})
	})

	it("falls back to defaults when goal is not an object", () => {
		seed({ goal: "nonsense" })
		expect(getGoalSettings()).toEqual(DEFAULT_GOAL_SETTINGS)
	})

	it("reads fresh on every call instead of caching a stale value", () => {
		seed({ goal: { maxUnchangedContinuations: 4 } })
		expect(getGoalSettings().maxUnchangedContinuations).toBe(4)

		seed({ goal: { maxUnchangedContinuations: 12 } })
		expect(getGoalSettings().maxUnchangedContinuations).toBe(12)
	})

	it("never throws even when settings.json is malformed", () => {
		writeJson(testPath, {}) // reset to valid JSON first
		const { writeFileSync } = require("node:fs")
		writeFileSync(testPath, "{ not valid json", "utf-8")
		expect(() => getGoalSettings()).not.toThrow()
		expect(getGoalSettings()).toEqual(DEFAULT_GOAL_SETTINGS)
	})
})
