import { describe, expect, it } from "vitest"
import { escapeMarkdownCell, renderMarkdownTable } from "./markdown-table.js"

describe("escapeMarkdownCell", () => {
	it("escapes pipes", () => {
		expect(escapeMarkdownCell("a|b")).toBe("a\\|b")
	})
	it("flattens newlines and collapses whitespace", () => {
		expect(escapeMarkdownCell("a\nb\r\n  c\t d")).toBe("a b c d")
	})
})

describe("renderMarkdownTable", () => {
	it("renders header, separator, rows", () => {
		expect(
			renderMarkdownTable(
				["A", "B"],
				[
					["1", "2"],
					["3", "4"],
				],
			),
		).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |")
	})
	it("keeps rows with injected newlines in a single logical cell", () => {
		const out = renderMarkdownTable(["A"], [["line1\nline2"]])
		expect(out.split("\n")).toHaveLength(3)
	})
	it("returns empty string with no header", () => {
		expect(renderMarkdownTable([], [["1"]])).toBe("")
	})
})
