import { describe, expect, it } from "vitest"
import { extractSelectionText } from "./selection.js"

describe("extractSelectionText", () => {
	it("extracts on a single row and partial columns", () => {
		const lines = ["hello world"]
		const text = extractSelectionText(lines, { x: 2, y: 1 }, { x: 5, y: 1 })
		expect(text).toBe("ello")
	})

	it("handles reversed coordinates on a single row", () => {
		const lines = ["hello world"]
		const text = extractSelectionText(lines, { x: 5, y: 1 }, { x: 2, y: 1 })
		expect(text).toBe("ello")
	})

	it("extracts full middle rows with partial start and end", () => {
		const lines = ["line one", "line two", "line three"]
		const text = extractSelectionText(lines, { x: 3, y: 1 }, { x: 4, y: 3 })
		expect(text).toBe("ne one\nline two\nline")
	})

	it("strips ANSI escape sequences before extracting", () => {
		const lines = ["\x1b[31mABC\x1b[0mDEF"]
		const text = extractSelectionText(lines, { x: 1, y: 1 }, { x: 6, y: 1 })
		expect(text).toBe("ABCDEF")
	})

	it("outputs a single full row when the selection spans the whole line", () => {
		const lines = ["short"]
		const text = extractSelectionText(lines, { x: 1, y: 1 }, { x: 5, y: 1 })
		expect(text).toBe("short")
	})

	it("returns an empty string when coordinates are out of range", () => {
		const lines: string[] = []
		const text = extractSelectionText(lines, { x: 1, y: 1 }, { x: 5, y: 1 })
		expect(text).toBe("")
	})

	it("handles backward multi-row drag (end above start)", () => {
		const lines = ["first line", "second line", "third line"]
		// Drag from row 3 col 5 upward to row 1 col 2
		const text = extractSelectionText(lines, { x: 5, y: 3 }, { x: 2, y: 1 })
		// startRow = min(3,1)-1 = 0, endRow = max(3,1)-1 = 2
		// startCol = end.x-1 = 1 (top row), endCol = start.x-1 = 4 (bottom row)
		expect(text).toBe("irst line\nsecond line\nthird")
	})

	it("works with viewport-adjusted coordinates (simulating scrolled view)", () => {
		// Simulates what happens after the caller adjusts screen coords by
		// viewport offset: e.g. screen Y=1 with prevViewportTop=50 → y=51
		const lines = Array.from({ length: 55 }, (_, i) => `line ${i}`)
		const text = extractSelectionText(lines, { x: 1, y: 51 }, { x: 6, y: 51 })
		expect(text).toBe("line 5")
	})

	it("clamps selection to available lines when end exceeds array", () => {
		const lines = ["only line"]
		// Selection spans rows 1-3, but only 1 line exists
		const text = extractSelectionText(lines, { x: 1, y: 1 }, { x: 5, y: 3 })
		expect(text).toBe("only line")
	})
})
