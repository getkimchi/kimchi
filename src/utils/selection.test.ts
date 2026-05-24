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
})
