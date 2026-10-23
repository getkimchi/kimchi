import { describe, expect, it } from "vitest"
import { makeCustomXlsx, makeOfficeShapedXlsx, makeSimplePptx, makeSimpleXlsx } from "../fixtures/builders.js"
import { extractCsv, extractXlsx, isDateFormatCode, parseCsv, serialToIso } from "./xlsx.js"

describe("extractXlsx", () => {
	it("lists sheets with hidden state and counts", async () => {
		const doc = await extractXlsx(await makeSimpleXlsx())
		expect(doc.format).toBe("xlsx")
		expect(doc.sheets.map((s) => s.name)).toEqual(["Data", "Scratch"])
		expect(doc.sheets[0].state).toBe("visible")
		expect(doc.sheets[1].state).toBe("hidden")
		expect(doc.notes.some((n) => n.includes("hidden sheets: Scratch"))).toBe(true)
	})

	it("renders shared strings, inline strings, booleans, errors, dates and formulas with row/column locators", async () => {
		const doc = await extractXlsx(await makeSimpleXlsx())
		const w = doc.window({ sheet: 1, startRow: 1, endRow: 3, showFormulas: true })
		const lines = w.markdown.split("\n")
		expect(lines[0]).toBe("|  | A | B | C | D |")
		expect(lines).toContain("| 1 | padding cell | 2.5 | 2024-01-01 | =A1&B1 → 0 |")
		expect(lines).toContain("| 2 | inline note | TRUE | 2025-12-31 | =SUM(B1:B2) → 1.5 |")
		expect(lines).toContain("| 3 | #DIV/0! | -7 |  |  |")
	})

	it("reads an Excel 2010+ shaped workbook (x14ac/mc/xr namespaces on rows)", async () => {
		const doc = await extractXlsx(await makeOfficeShapedXlsx())
		expect(doc.sheets.map((s) => s.name)).toEqual(["Data"])
		const w = doc.window({ sheet: 1, startRow: 1, endRow: 2 })
		expect(w.markdown).toContain("| 1 | padding cell | 2023-01-01 | 0 |")
		expect(w.markdown).toContain("| 2 | 2.5 | -7 |  |")
	})

	it("reads formulas from an Excel 2010+ shaped workbook with --show-formulas semantics", async () => {
		const doc = await extractXlsx(await makeOfficeShapedXlsx())
		const w = doc.window({ sheet: "Data", startRow: 1, endRow: 1, showFormulas: true })
		expect(w.markdown).toContain("=A1&B1 → 0")
	})

	it("throws a typed corrupt error on a malformed row instead of a raw stack", async () => {
		const bytes = await makeCustomXlsx([
			{
				name: "S",
				inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><zz:c r="A2"><v>2</v></zz:c></row></sheetData>`,
			},
		])
		try {
			const doc = await extractXlsx(bytes)
			doc.window({ sheet: 1, startRow: 1, endRow: 2 })
			expect.unreachable()
		} catch (err) {
			expect((err as { code?: string }).code).toBe("corrupt")
		}
	})

	it("shows cached values only by default", async () => {
		const doc = await extractXlsx(await makeSimpleXlsx())
		const w = doc.window({ sheet: "Data" })
		expect(w.markdown).not.toContain("=SUM(")
		expect(w.markdown).toContain("| 2 | inline note | TRUE | 2025-12-31 | 1.5 |")
	})

	it("windows by rows with truncation at the character cap", async () => {
		const rows = Array.from(
			{ length: 50 },
			(_, i) =>
				`<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>row ${i + 1} filler filler filler</t></is></c></row>`,
		).join("")
		const doc = await extractXlsx(await makeCustomXlsx([{ name: "S", inner: `<sheetData>${rows}</sheetData>` }]))
		const w = doc.window({ sheet: 1, startRow: 1, endRow: 50, maxChars: 800 })
		expect(w.fromRow).toBe(1)
		expect(w.toRow).toBeLessThan(50)
		expect(w.truncated).toBe(true)
		const w2 = doc.window({ sheet: 1, startRow: 45, endRow: 50 })
		expect(w2.markdown).toContain("| 50 | row 50 filler filler filler |")
	})

	it("honors the 1904 date system", async () => {
		const doc1900 = await extractXlsx(
			await makeCustomXlsx([
				{ name: "S", inner: `<sheetData><row r="1"><c r="A1" s="1"><v>45292</v></c></row></sheetData>` },
			]),
		)
		const doc1904 = await extractXlsx(
			await makeCustomXlsx(
				[{ name: "S", inner: `<sheetData><row r="1"><c r="A1" s="1"><v>45292</v></c></row></sheetData>` }],
				{
					date1904: true,
				},
			),
		)
		expect(doc1900.window({}).markdown).toContain("2024-01-01")
		expect(doc1904.window({}).markdown).toContain("2028-01-02")
	})

	it("flags macros and external links", async () => {
		const doc = await extractXlsx(
			(await makeCustomXlsx([{ name: "S", inner: "<sheetData/>" }]).then(async (data) => {
				const JSZip = (await import("jszip")).default
				const zip = await JSZip.loadAsync(data)
				zip.file("xl/vbaProject.bin", new Uint8Array([1, 2, 3]))
				return zip.generateAsync({ type: "uint8array" })
			})) as Uint8Array,
		)
		expect(doc.info.hasMacros).toBe(true)
		expect(doc.notes.some((n) => n.includes("macros"))).toBe(true)
	})

	it("rejects non-xlsx input", async () => {
		await expect(extractXlsx(await makeSimplePptx())).rejects.toMatchObject({ code: "corrupt", format: "xlsx" })
	})
})

describe("serialToIso", () => {
	it("converts 1900 and 1904 serials in UTC", () => {
		expect(serialToIso(45292, false, "date")).toBe("2024-01-01")
		expect(serialToIso(45292, true, "date")).toBe("2028-01-02")
		expect(serialToIso(60, false, "date")).toBe("1900-02-29") // phantom day retained
		expect(serialToIso(61, false, "date")).toBe("1900-03-01")
	})
})

describe("isDateFormatCode", () => {
	it("detects date-like formats and rejects numeric ones", () => {
		expect(isDateFormatCode("yyyy-mm-dd")).toBe(true)
		expect(isDateFormatCode('yyyy"年"m"月"d"日"')).toBe(true)
		expect(isDateFormatCode("h:mm:ss")).toBe(true)
		expect(isDateFormatCode("[Red]-#,##0")).toBe(false)
		expect(isDateFormatCode("0.00%")).toBe(false)
	})
})

describe("CSV", () => {
	it("parses RFC 4180 quoting", () => {
		expect(parseCsv('a,"b,1","say ""hi"""\r\nc,d,e\nf,g,last')).toEqual([
			["a", "b,1", 'say "hi"'],
			["c", "d", "e"],
			["f", "g", "last"],
		])
	})

	it("renders csv through the same window shape", () => {
		const doc = extractCsv("name,age\nalice,30\nbob,25\n")
		expect(doc.format).toBe("csv")
		const w = doc.window({})
		expect(w.markdown).toContain("|  | A | B |")
		expect(w.markdown).toContain("| 1 | name | age |")
		expect(w.markdown).toContain("| 3 | bob | 25 |")
	})
})
