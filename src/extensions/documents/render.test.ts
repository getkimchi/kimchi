import { describe, expect, it } from "vitest"
import type { ExtractedDocument } from "./model.js"
import { parseUnitRange, renderDocument, renderOutline, sliceSheetRows } from "./render.js"

const doc: ExtractedDocument = {
	format: "pdf",
	unitKind: "page",
	units: [
		{ index: 1, label: "Page 1", markdown: "alpha" },
		{ index: 2, label: "Page 2", markdown: "beta" },
		{ index: 3, label: "Page 3", markdown: "gamma" },
	],
	outline: ["Page 1: alpha", "Page 2: beta", "Page 3: gamma"],
	notes: [],
}

describe("parseUnitRange", () => {
	it("parses single, ranges, lists, open-ended tails", () => {
		expect(parseUnitRange("2", 3)).toEqual([2])
		expect(parseUnitRange("1-2", 3)).toEqual([1, 2])
		expect(parseUnitRange("1,3", 3)).toEqual([1, 3])
		expect(parseUnitRange("2-", 3)).toEqual([2, 3])
	})
	it("clamps past-the-end and rejects junk", () => {
		expect(parseUnitRange("2-99", 3)).toEqual([2, 3])
		expect(parseUnitRange("x", 3)).toBeUndefined()
		expect(parseUnitRange("0", 3)).toBeUndefined()
		expect(parseUnitRange("3-1", 3)).toBeUndefined()
	})
})

describe("renderDocument", () => {
	it("renders header, sections and selection metadata", () => {
		const out = renderDocument(doc, { path: "/w/report.pdf" })
		expect(out.text).toContain("# report.pdf (pdf — 3 pages)")
		expect(out.text).toContain("## Page 2\n\nbeta")
		expect(out).toMatchObject({ totalUnits: 3, selectedUnits: 3, truncated: false })
	})

	it("selects units by index", () => {
		const out = renderDocument(doc, { unitIndices: [3] })
		expect(out.text).toContain("1 of 3")
		expect(out.text).toContain("gamma")
		expect(out.text).not.toContain("alpha")
	})

	it("caps output with a continuation hint", () => {
		const out = renderDocument(doc, { maxChars: 40 })
		expect(out.truncated).toBe(true)
		expect(out.text).toContain("output truncated at 40 characters")
		expect(out.text).toContain("read_document")
	})
})

describe("sliceSheetRows", () => {
	const table = "preamble\n|  | A | B |\n| --- | --- | --- |\n| 1 | x | y |\n| 2 | u | v |\n| 3 | p | q |"
	it("keeps a row range plus headers", () => {
		const sliced = sliceSheetRows(table, "2-3")
		expect(sliced).toContain("|  | A | B |")
		expect(sliced).not.toContain("| 1 |")
		expect(sliced).toContain("| 2 |")
		expect(sliced).toContain("| 3 |")
		expect(sliced).toContain("preamble")
	})
	it("accepts a single row", () => {
		expect(sliceSheetRows(table, "1")).toContain("| 1 |")
		expect(sliceSheetRows(table, "1")).not.toContain("| 2 |")
	})
	it("passes through on junk input", () => {
		expect(sliceSheetRows(table, "abc")).toBe(table)
	})
})

describe("renderOutline", () => {
	it("lists units and a read_document pointer", () => {
		const text = renderOutline(doc, "/big/deck.pdf")
		expect(text).toContain("deck.pdf (pdf, 3 pages)")
		expect(text).toContain("- Page 1: alpha")
		expect(text).toContain('read_document: { path: "/big/deck.pdf", pages: "1-5" }')
	})
})
