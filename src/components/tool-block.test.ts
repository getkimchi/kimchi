import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { buildAlignedLine } from "./tool-block.js"

describe("buildAlignedLine", () => {
	it("returns left as-is when right is empty and left fits", () => {
		const out = buildAlignedLine("hello", "", 10)
		expect(out).toBe("hello")
	})

	it("truncates left when right is empty and left exceeds width", () => {
		const out = buildAlignedLine("hello world", "", 5)
		expect(visibleWidth(out)).toBeLessThanOrEqual(5)
	})

	it("right exactly fills width: returns right alone", () => {
		const right = "0123456789"
		const out = buildAlignedLine("left", right, right.length)
		expect(visibleWidth(out)).toBeLessThanOrEqual(right.length)
	})

	it("right wider than width: result still fits", () => {
		const out = buildAlignedLine("left", "0123456789", 5)
		expect(visibleWidth(out)).toBeLessThanOrEqual(5)
	})

	it("leftW + rightW + 2 == width: natural fit", () => {
		const left = "abc"
		const right = "xyz"
		const out = buildAlignedLine(left, right, 8) // 3 + 2 + 3
		expect(out).toBe("abc  xyz")
		expect(visibleWidth(out)).toBe(8)
	})

	it("leftW + rightW + 2 == width + 1: truncates without overflow", () => {
		const left = "abcd"
		const right = "xyz"
		const out = buildAlignedLine(left, right, 8) // 4 + 2 + 3 = 9 > 8
		expect(visibleWidth(out)).toBeLessThanOrEqual(8)
		expect(out.endsWith("xyz")).toBe(true)
	})

	it("leftW + rightW + 2 == width + 2: truncates without overflow", () => {
		const left = "abcde"
		const right = "xyz"
		const out = buildAlignedLine(left, right, 8) // 5 + 2 + 3 = 10 > 8
		expect(visibleWidth(out)).toBeLessThanOrEqual(8)
		expect(out.endsWith("xyz")).toBe(true)
	})

	it("available <= 0 (right takes almost full width): drops left, no overflow", () => {
		const left = "leftcontent"
		const right = "0123456" // width 7
		const out = buildAlignedLine(left, right, 8) // available = 8 - 7 - 2 = -1
		expect(visibleWidth(out)).toBeLessThanOrEqual(8)
		expect(out.endsWith(right)).toBe(true)
	})

	it("ansi-wrapped inputs: visible width respected", () => {
		const left = `\x1b[31m${"description with color".padEnd(40, " ")}\x1b[0m`
		const right = "\x1b[2m99.9s\x1b[0m" // visible width 5
		const out = buildAlignedLine(left, right, 30)
		expect(visibleWidth(out)).toBeLessThanOrEqual(30)
	})

	it("width <= 0: returns empty", () => {
		expect(buildAlignedLine("left", "right", 0)).toBe("")
		expect(buildAlignedLine("left", "right", -1)).toBe("")
	})

	it("matches exact width when natural fit applies", () => {
		const out = buildAlignedLine("hi", "bye", 10) // 2 + 5 + 3 = 10
		expect(visibleWidth(out)).toBe(10)
	})
})
