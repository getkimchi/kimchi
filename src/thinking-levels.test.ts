import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import {
	CANONICAL_THINKING_LEVELS,
	deriveThinkingLevelMap,
	normalizeThinkingLevels,
	THINKING_LEVEL_DESCRIPTIONS,
	thinkingColumnValue,
	thinkingLevelDescription,
	thinkingLevelName,
} from "./thinking-levels.js"

const GATEWAY_BASE: ThinkingLevelMap = { off: "none", max: "max" }

describe("normalizeThinkingLevels", () => {
	it("sorts unsorted input into canonical rank order", () => {
		expect(normalizeThinkingLevels(["max", "off", "high", "low"])).toEqual(["off", "low", "high", "max"])
		expect(normalizeThinkingLevels(["high", "minimal", "xhigh", "medium"])).toEqual([
			"minimal",
			"medium",
			"high",
			"xhigh",
		])
	})

	it("filters unknown levels", () => {
		expect(normalizeThinkingLevels(["low", "turbo", "high", "bogus"] as unknown as ModelThinkingLevel[])).toEqual([
			"low",
			"high",
		])
		expect(normalizeThinkingLevels(["nonsense"] as unknown as ModelThinkingLevel[])).toEqual([])
		expect(normalizeThinkingLevels([])).toEqual([])
	})

	it("deduplicates and preserves every canonical level", () => {
		expect(normalizeThinkingLevels(["low", "low", "max"])).toEqual(["low", "max"])
		expect(normalizeThinkingLevels([...CANONICAL_THINKING_LEVELS])).toEqual([...CANONICAL_THINKING_LEVELS])
	})
})

describe("deriveThinkingLevelMap", () => {
	it("nulls the canonical levels the catalog omits and keeps base translations", () => {
		expect(deriveThinkingLevelMap(["off", "low", "high", "max"], GATEWAY_BASE)).toEqual({
			off: "none",
			max: "max",
			minimal: null,
			medium: null,
			xhigh: null,
		})
	})

	it("makes off unsupported when the catalog does not curate it", () => {
		expect(deriveThinkingLevelMap(["low", "high", "max"], GATEWAY_BASE)).toEqual({
			off: null,
			minimal: null,
			medium: null,
			xhigh: null,
			max: "max",
		})
	})

	it("leaves curated levels without a base translation absent (sent verbatim)", () => {
		expect(deriveThinkingLevelMap(["off", "medium", "high"], GATEWAY_BASE)).toEqual({
			off: "none",
			minimal: null,
			low: null,
			xhigh: null,
			max: null,
		})
	})

	it("leaves only off reachable for the curated empty array", () => {
		expect(deriveThinkingLevelMap([], GATEWAY_BASE)).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: null,
		})
	})

	it("normalizes scrambled and unknown catalog levels before deriving", () => {
		expect(deriveThinkingLevelMap(["max", "turbo", "off"] as unknown as ModelThinkingLevel[], GATEWAY_BASE)).toEqual({
			off: "none",
			max: "max",
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
		})
	})

	it("names curated xhigh and max explicitly when the base has no translation", () => {
		expect(deriveThinkingLevelMap(["high", "xhigh"], GATEWAY_BASE)).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			xhigh: "xhigh",
			max: null,
		})
		expect(deriveThinkingLevelMap(["max"], {})).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: "max",
		})
	})

	it("preserves every base translation for a catalog curating all levels", () => {
		const base: ThinkingLevelMap = {
			off: "none",
			minimal: "min",
			low: "low",
			medium: "med",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		}
		expect(deriveThinkingLevelMap([...CANONICAL_THINKING_LEVELS], base)).toEqual(base)
	})
})

describe("thinkingColumnValue", () => {
	it("renders curated levels as a comma+space list in canonical order", () => {
		expect(thinkingColumnValue(["off", "low", "high", "max"], true)).toBe("off, low, high, max")
		expect(thinkingColumnValue(["low", "high", "max"], true)).toBe("low, high, max")
	})

	it("renders canonical order even when the wire order is scrambled", () => {
		expect(thinkingColumnValue(["max", "high", "off"], false)).toBe("off, high, max")
	})

	it('renders a curated ["off"] as off — curated truth wins over the reasoning flag', () => {
		expect(thinkingColumnValue(["off"], true)).toBe("off")
		expect(thinkingColumnValue(["off"], false)).toBe("off")
	})

	it("renders the curated empty array (no distinct levels) as on for a reasoning model", () => {
		// "thinking_levels":[] is a first-class curation: thinking exists, the
		// provider default applies, no level controls.
		expect(thinkingColumnValue([], true)).toBe("on")
	})

	it("renders the curated empty array as off when the model does not reason", () => {
		expect(thinkingColumnValue([], false)).toBe("off")
	})

	it("renders an absent field (uncurated) as not curated for a reasoning model — levels must not be inferred", () => {
		expect(thinkingColumnValue(undefined, true)).toBe("not curated")
	})

	it("renders an absent field as off for a non-reasoning model (hard fact, not curation)", () => {
		expect(thinkingColumnValue(undefined, false)).toBe("off")
	})
})

describe("thinkingLevelName", () => {
	it("names every canonical level — exhaustiveness is compile-enforced via the ModelThinkingLevel key union", () => {
		// Mirrors the map in thinking-levels.ts; a level added upstream without
		// a name fails to compile there, and this pins the user-visible labels
		// (agent-supplied in the ACP option; "Extra high" for xhigh follows
		// the ecosystem convention).
		expect(CANONICAL_THINKING_LEVELS.map((level) => thinkingLevelName(level))).toEqual([
			"Off",
			"Minimal",
			"Low",
			"Medium",
			"High",
			"Extra high",
			"Max",
		])
	})

	it("falls back to the level id for an unknown value", () => {
		expect(thinkingLevelName("turbo")).toBe("turbo")
	})
})

describe("thinkingLevelDescription", () => {
	it("returns the use-case line for a canonical level", () => {
		expect(thinkingLevelDescription("high")).toBe(THINKING_LEVEL_DESCRIPTIONS.high)
	})

	it("returns undefined for an unknown value", () => {
		expect(thinkingLevelDescription("turbo")).toBeUndefined()
	})
})
