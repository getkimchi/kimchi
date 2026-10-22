import { describe, expect, it } from "vitest"
import {
	columnIndex,
	columnLetter,
	formatCellRef,
	parseCellRef,
	parseRangeRef,
	quoteSheetName,
	splitSheetRef,
} from "./xlsx-refs.js"

describe("column letters", () => {
	it("roundtrips A..XFD", () => {
		expect(columnLetter(1)).toBe("A")
		expect(columnLetter(26)).toBe("Z")
		expect(columnLetter(27)).toBe("AA")
		expect(columnLetter(703)).toBe("AAA")
		expect(columnLetter(16384)).toBe("XFD")
		for (const n of [1, 2, 25, 26, 27, 52, 53, 702, 703, 16384]) {
			expect(columnIndex(columnLetter(n))).toBe(n)
		}
		expect(columnIndex("b")).toBe(2)
	})
})

describe("parseCellRef", () => {
	it("parses absolute and relative refs", () => {
		expect(parseCellRef("B12")).toEqual({ column: 2, row: 12 })
		expect(parseCellRef("$B$12")).toEqual({ column: 2, row: 12 })
		expect(parseCellRef("xfd1")).toEqual({ column: 16384, row: 1 })
		expect(parseCellRef("nope")).toBeUndefined()
	})
	it("formatCellRef roundtrips", () => {
		expect(formatCellRef({ column: 2, row: 12 })).toBe("B12")
	})
})

describe("parseRangeRef", () => {
	it("parses ranges and degenerate cells", () => {
		expect(parseRangeRef("A1:B2")).toEqual({ start: { column: 1, row: 1 }, end: { column: 2, row: 2 } })
		expect(parseRangeRef("C7")).toEqual({ start: { column: 3, row: 7 }, end: { column: 3, row: 7 } })
		expect(parseRangeRef("no")).toBeUndefined()
	})
})

describe("sheet refs", () => {
	it("splits quoted and bare sheet qualifiers", () => {
		expect(splitSheetRef("Sheet1!A1")).toEqual({ sheet: "Sheet1", ref: "A1" })
		expect(splitSheetRef("'My Sheet'!A1")).toEqual({ sheet: "My Sheet", ref: "A1" })
		expect(splitSheetRef("'It''s here'!$B$2")).toEqual({ sheet: "It's here", ref: "$B$2" })
		expect(splitSheetRef("A1")).toEqual({ sheet: undefined, ref: "A1" })
		expect(quoteSheetName("It's here")).toBe("'It''s here'")
		expect(quoteSheetName("Data")).toBe("Data")
	})
})
