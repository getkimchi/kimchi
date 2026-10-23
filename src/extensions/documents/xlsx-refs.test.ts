import { describe, expect, it } from "vitest"
import {
	columnIndex,
	columnLetter,
	formatCellRef,
	formulaReferencesSheet,
	parseCellRef,
	parseRangeRef,
	quoteSheetName,
	renameSheetInFormula,
	splitSheetRef,
	validateSheetName,
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

	it("quotes names that look like cell refs, R1C1 refs or constants", () => {
		expect(quoteSheetName("A1")).toBe("'A1'")
		expect(quoteSheetName("R1C1")).toBe("'R1C1'")
		expect(quoteSheetName("RC")).toBe("'RC'")
		expect(quoteSheetName("TRUE")).toBe("'TRUE'")
		expect(quoteSheetName("false")).toBe("'false'")
		expect(quoteSheetName("Data_1")).toBe("Data_1")
	})
})

describe("validateSheetName", () => {
	it("accepts ordinary names and rejects Excel's forbidden shapes", () => {
		expect(validateSheetName("Data 2026")).toBeUndefined()
		expect(validateSheetName("R&D_1")).toBeUndefined()
		expect(validateSheetName(" ")).toBeTruthy()
		expect(validateSheetName("x".repeat(32))).toBeTruthy()
		expect(validateSheetName("a/b")).toBeTruthy()
		expect(validateSheetName("a:b")).toBeTruthy()
		expect(validateSheetName("[k]")).toBeTruthy()
		expect(validateSheetName("'lead")).toBeTruthy()
		expect(validateSheetName("trail'")).toBeTruthy()
		expect(validateSheetName("History")).toBeTruthy()
		expect(validateSheetName("history")).toBeTruthy()
	})
})

describe("renameSheetInFormula", () => {
	const cases: Array<{ formula: string; renamed: string }> = [
		{ formula: "=Data!A1*2", renamed: "='Raw Data'!A1*2" },
		{ formula: "=SUM(Data!A:A)", renamed: "=SUM('Raw Data'!A:A)" },
		{ formula: "=Data!1:1", renamed: "='Raw Data'!1:1" },
		{ formula: "=Data!Total*2", renamed: "='Raw Data'!Total*2" },
		{ formula: "=Data:Other!A1", renamed: "='Raw Data':Other!A1" },
		{ formula: "=Other:Data!A1", renamed: "=Other:'Raw Data'!A1" },
		{ formula: "='Data'!A1", renamed: "='Raw Data'!A1" },
		{ formula: "=DATA!A1", renamed: "='Raw Data'!A1" },
		// string literals and external refs untouched
		{ formula: `=CONCAT("Data!A1 is ",Data!A1)`, renamed: `=CONCAT("Data!A1 is ",'Raw Data'!A1)` },
		{ formula: "=[1]Data!A1", renamed: "=[1]Data!A1" },
		// no partial match
		{ formula: "=MyData!A1", renamed: "=MyData!A1" },
		{ formula: "=DataX!A1+B1", renamed: "=DataX!A1+B1" },
		// unrelated content untouched (numbers, functions, ranges)
		{ formula: "=IF(A1>0,SUM(B2:B4),0.5e3)", renamed: "=IF(A1>0,SUM(B2:B4),0.5e3)" },
	]
	for (const { formula, renamed } of cases) {
		it(`${formula} → ${renamed}`, () => {
			expect(renameSheetInFormula(formula, "Data", "Raw Data")).toBe(renamed)
		})
	}

	it("round-trips a quoted old name to a bare new name", () => {
		expect(renameSheetInFormula("='Raw Data'!A1", "Raw Data", "Data")).toBe("=Data!A1")
	})

	it("escapes apostrophes in the new name", () => {
		expect(renameSheetInFormula("=Data!A1", "Data", "O'Brien")).toBe("='O''Brien'!A1")
	})
})

describe("formulaReferencesSheet", () => {
	it("matches any end of a 3D span and ignores literals/, external refs and partial names", () => {
		expect(formulaReferencesSheet("=SUM(Data!A:A)+", "Data")).toBe(true)
		expect(formulaReferencesSheet("=Data:Other!A1", "Other")).toBe(true)
		expect(formulaReferencesSheet('="Data"+A1', "Data")).toBe(false)
		expect(formulaReferencesSheet("=[1]Data!A1", "Data")).toBe(false)
		expect(formulaReferencesSheet("=MyData!A1", "Data")).toBe(false)
		expect(formulaReferencesSheet("=A1?B2", "Data")).toBe(false)
	})
})
