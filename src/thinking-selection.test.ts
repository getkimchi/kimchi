import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __clearModelThinkingLevelsForTest, registerModelThinkingLevels } from "./models.js"
import { CANONICAL_THINKING_LEVELS } from "./thinking-levels.js"
import {
	__uninstallThinkingLevelAdvisorForTest,
	clampToSelection,
	installThinkingLevelAdvisor,
	type KimchiThinkingLevelInfo,
	type ThinkingSelectionModel,
	thinkingSelection,
} from "./thinking-selection.js"

/** ai-enabler models all carry this map (src/models.ts metadataToModel). */
const AI_ENABLER_MAP = { off: "none", max: "max" }
/** pi's filter keeps off..high for map-less reasoning models (xhigh/max excluded). */
const PI_MAPLESS_SET = ["off", "minimal", "low", "medium", "high"]
/** …and adds max for the ai-enabler map (explicit entry). */
const PI_AI_ENABLER_SET = ["off", "minimal", "low", "medium", "high", "max"]

function model(overrides: Partial<ThinkingSelectionModel> = {}): ThinkingSelectionModel {
	return { provider: "kimchi-dev", id: "test-model", reasoning: true, ...overrides }
}

function advisorCall(model: unknown): KimchiThinkingLevelInfo | undefined {
	const globals = process as typeof process & { __kimchiThinkingLevelAdvisor?: (m: unknown) => KimchiThinkingLevelInfo }
	return globals.__kimchiThinkingLevelAdvisor?.(model)
}

beforeEach(() => {
	__clearModelThinkingLevelsForTest()
})

afterEach(() => {
	__clearModelThinkingLevelsForTest()
	__uninstallThinkingLevelAdvisorForTest()
})

describe("thinkingSelection", () => {
	it("returns all canonical levels when there is no model", () => {
		expect(thinkingSelection(undefined)).toEqual({ mode: "levels", selectable: [...CANONICAL_THINKING_LEVELS] })
	})

	it("returns none/off for a non-reasoning model regardless of curation", () => {
		registerModelThinkingLevels("kimchi-dev/flash-lite", ["low", "high"])
		expect(thinkingSelection(model({ id: "flash-lite", reasoning: false }))).toEqual({
			mode: "none",
			reasoning: false,
			noneReason: "no-reasoning",
		})
	})

	it("keeps pi's computed set for an uncurated reasoning model", () => {
		expect(thinkingSelection(model({ thinkingLevelMap: undefined }))).toEqual({
			mode: "levels",
			selectable: PI_MAPLESS_SET,
		})
		expect(thinkingSelection(model({ thinkingLevelMap: AI_ENABLER_MAP }))).toEqual({
			mode: "levels",
			selectable: PI_AI_ENABLER_SET,
		})
	})

	it("intersects curated levels with pi's map-supported set", () => {
		registerModelThinkingLevels("kimchi-dev/glm-5.3", ["low", "high", "max"])
		expect(thinkingSelection(model({ id: "glm-5.3", thinkingLevelMap: AI_ENABLER_MAP }))).toEqual({
			mode: "levels",
			selectable: ["low", "high", "max"],
		})
	})

	it("drops a curated level the map rejects (off mapped to null)", () => {
		// claude-fable-5 style map: thinking cannot be disabled.
		registerModelThinkingLevels("kimchi-dev/fable", ["off", "low", "high"])
		expect(thinkingSelection(model({ id: "fable", thinkingLevelMap: { off: null, max: "max" } }))).toEqual({
			mode: "levels",
			selectable: ["low", "high"],
		})
	})

	it("degrades to none when curation and the wire format disagree entirely", () => {
		// xhigh is curated but no map-less model exposes it.
		registerModelThinkingLevels("kimchi-dev/xonly", ["xhigh"])
		expect(thinkingSelection(model({ id: "xonly" }))).toEqual({
			mode: "none",
			reasoning: true,
			noneReason: "empty-intersection",
		})
	})

	it("treats the curated empty array as curated-none (on at the provider default)", () => {
		registerModelThinkingLevels("kimchi-dev/minimax-m3", [])
		expect(thinkingSelection(model({ id: "minimax-m3", thinkingLevelMap: AI_ENABLER_MAP }))).toEqual({
			mode: "none",
			reasoning: true,
			noneReason: "curated-none",
		})
	})
})

describe("clampToSelection", () => {
	const curated = ["low", "high", "max"]

	it("keeps a level that is already selectable", () => {
		expect(clampToSelection("high", { mode: "levels", selectable: curated })).toBe("high")
	})

	it("clamps upward first, mirroring pi-ai's strategy", () => {
		expect(clampToSelection("medium", { mode: "levels", selectable: curated })).toBe("high")
		expect(clampToSelection("off", { mode: "levels", selectable: ["low", "high"] })).toBe("low")
	})

	it("clamps downward when nothing above is selectable", () => {
		expect(clampToSelection("max", { mode: "levels", selectable: ["low", "high"] })).toBe("high")
	})

	it("falls back to the first selectable level for unknown levels", () => {
		expect(clampToSelection("turbo", { mode: "levels", selectable: curated })).toBe("low")
	})

	it("clamps to off when nothing is selectable, so no effort is derived", () => {
		expect(clampToSelection("high", { mode: "none", reasoning: true, noneReason: "curated-none" })).toBe("off")
		expect(clampToSelection("high", { mode: "levels", selectable: [] })).toBe("off")
	})
})

describe("installThinkingLevelAdvisor", () => {
	it("publishes the dist seam on the process global", () => {
		installThinkingLevelAdvisor()
		registerModelThinkingLevels("kimchi-dev/glm-5.3", ["low", "high", "max"])
		const info = advisorCall(model({ id: "glm-5.3", thinkingLevelMap: AI_ENABLER_MAP }))
		expect(info?.selectable).toEqual(["low", "high", "max"])
		expect(info?.noneReason).toBeNull()
		expect(info?.levels).toEqual(
			CANONICAL_THINKING_LEVELS.map((level) => ({ level, selectable: ["low", "high", "max"].includes(level) })),
		)
		expect(info?.clamp("medium")).toBe("high")
		expect(info?.clamp("off")).toBe("low")
	})

	it("reports a noneReason when nothing is selectable", () => {
		installThinkingLevelAdvisor()
		registerModelThinkingLevels("kimchi-dev/minimax-m3", [])
		const info = advisorCall(model({ id: "minimax-m3" }))
		expect(info?.selectable).toEqual([])
		expect(info?.noneReason).toBe("curated-none")
		expect(info?.levels.every((entry) => !entry.selectable)).toBe(true)
		expect(info?.clamp("high")).toBe("off")
	})

	it("returns null for non-model input so the dist falls back", () => {
		installThinkingLevelAdvisor()
		expect(advisorCall(undefined)).toBeNull()
		expect(advisorCall("glm-5.3")).toBeNull()
		expect(advisorCall({ id: "keyless" })).toBeNull()
	})

	it("returns null instead of throwing when selection fails internally", () => {
		installThinkingLevelAdvisor()
		// thinkingLevelMap access throws: the advisor must degrade to the
		// pure-pi fallback rather than throw into a dist call site
		// (setThinkingLevel, cycling, completions, session creation).
		const malformed = Object.defineProperty(
			{ id: "evil", provider: "kimchi-dev", reasoning: true },
			"thinkingLevelMap",
			{
				get: () => {
					throw new Error("boom")
				},
			},
		)
		expect(advisorCall(malformed)).toBeNull()
	})
})
