import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import { extractDocument } from "../extract.js"

function makeWorkbook(options: { hiddenSecondSheet?: boolean } = {}): Uint8Array {
	const wb = XLSX.utils.book_new()
	const ws1 = XLSX.utils.aoa_to_sheet([
		["Name", "Amount", "Rate"],
		["North", 42, 0.5],
		["South", 7, 0.25],
	])
	ws1["B3"].z = "#,##0.00"
	ws1["C2"].z = "0%"
	// Formula cell (extends the aoa-computed range by one row)
	ws1["B4"] = { t: "n", f: "SUM(B3:B3)", v: 49, w: "49" }
	ws1["!ref"] = "A1:C4"
	XLSX.utils.book_append_sheet(wb, ws1, "Totals")
	const ws2 = XLSX.utils.aoa_to_sheet([
		["Region", "Note"],
		["East", "hidden-data"],
	])
	XLSX.utils.book_append_sheet(wb, ws2, "Detail")
	if (options.hiddenSecondSheet) {
		if (!wb.Workbook) wb.Workbook = { Sheets: [] }
		wb.Workbook.Sheets = [{ Hidden: 0 }, { Hidden: 1 }]
	}
	return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

describe("extractDocument(xlsx)", () => {
	it("renders sheets as row-numbered tables with column letters", async () => {
		const doc = await extractDocument("wb.xlsx", makeWorkbook())
		expect(doc.format).toBe("xlsx")
		expect(doc.unitKind).toBe("sheet")
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].label).toBe("Sheet: Totals")
		const md = doc.units[0].markdown
		expect(md).toContain("|  | A | B | C |")
		expect(md).toContain("| 1 | Name | Amount | Rate |")
		expect(md).toContain("| 2 | North | 42 | 50% |")
		expect(doc.outline[0]).toContain('"Totals"')
	})

	it("shows formulas when requested", async () => {
		const doc = await extractDocument("wb.xlsx", makeWorkbook(), { formulas: true })
		expect(doc.units[0].markdown).toContain("=SUM(B3:B3)")
		const docValues = await extractDocument("wb.xlsx", makeWorkbook())
		expect(docValues.units[0].markdown).not.toContain("=SUM")
	})

	it("flags hidden sheets in notes", async () => {
		const doc = await extractDocument("wb.xlsx", makeWorkbook({ hiddenSecondSheet: true }))
		expect(doc.notes).toContain('sheet "Detail" is hidden')
		expect(doc.units[1].markdown).toContain("*hidden sheet*")
	})

	it("formats dates from format codes (TZ-independent)", async () => {
		const wb = XLSX.utils.book_new()
		const ws = XLSX.utils.aoa_to_sheet([["When"], [{ t: "n", v: 45292, z: "yyyy-mm-dd" }]])
		ws["A2"].z = "yyyy-mm-dd"
		XLSX.utils.book_append_sheet(wb, ws, "Dates")
		const data = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
		const doc1 = await extractDocument("d.xlsx", data)
		const doc2 = await extractDocument("d.xlsx", data)
		expect(doc1.units[0].markdown).toBe(doc2.units[0].markdown)
		// Excel serial 45292 with the 1900 system rounds to 2024-01-01; the
		// invariant here is stability, not a specific calendar day.
		expect(doc1.units[0].markdown).toContain("2024-01-01")
	})

	it("reads csv text", async () => {
		const doc = await extractDocument("t.csv", new TextEncoder().encode("a,b\n1,2\n"))
		expect(doc.format).toBe("csv")
		expect(doc.units[0].markdown).toContain("| a | b |")
		expect(doc.units[0].markdown).toContain("| 1 | 2 |")
	})
})
