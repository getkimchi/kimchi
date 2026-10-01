import { describe, expect, it } from "vitest"
import { parseInt64 } from "./parse.js"

describe("parseInt64", () => {
	it.each([
		["1500", 1500],
		["0", 0],
		["-3", -3],
		["6442450944", 6442450944],
	])("parses canonical decimal string %s to %d", (raw, expected) => {
		expect(parseInt64(raw)).toBe(expected)
	})

	it("passes finite numbers through", () => {
		expect(parseInt64(1500)).toBe(1500)
	})

	it.each([
		["undefined", undefined],
		["null", null],
		["empty string", ""],
		["whitespace-only", "   "],
		["hex", "0x10"],
		["exponent", "1e3"],
		["fractional", "12.5"],
		["garbage", "banana"],
		["object", {}],
		["array", []],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
	])("returns undefined for %s", (_label, raw) => {
		expect(parseInt64(raw)).toBeUndefined()
	})
})
