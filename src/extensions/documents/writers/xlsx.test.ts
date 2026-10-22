import { describe, expect, it } from "vitest"
import { createPinnedClock } from "../clock.js"
import { extractXlsx } from "../extractors/xlsx.js"
import { openOoxml } from "../ooxml/package.js"
import { writeXlsx, type XlsxSpec } from "./xlsx.js"

const clock = createPinnedClock()

const spec: XlsxSpec = {
	title: "Budget",
	sheets: [
		{
			name: "Data",
			freezeHeader: true,
			columnWidths: { 1: 24, 2: 12 },
			rows: [
				[
					{ v: "Name", bold: true },
					{ v: "Amount", bold: true },
					{ v: "Date", bold: true },
					{ v: "Doubled", bold: true },
				],
				["alpha", 42.5, { v: 45292, fmt: "yyyy-mm-dd" }, { f: "B2*2" }],
				["beta", -3, { v: 46022, fmt: "yyyy-mm-dd" }, { f: "B3*2" }],
				["total", { f: "SUM(B2:B3)" }, null, true],
			],
		},
	],
}

describe("writeXlsx", () => {
	it("writes a workbook the extractor reads back with values, formats and formulas", async () => {
		const { bytes, warnings, formulas } = await writeXlsx(spec, { clock })
		expect(formulas).toBe(3)
		expect(warnings).toEqual([])
		const doc = await extractXlsx(bytes)
		expect(doc.sheets.map((s) => s.name)).toEqual(["Data"])
		expect(doc.info.title).toBe("Budget")
		const w = doc.window({ sheet: 1, showFormulas: true })
		expect(w.markdown).toContain("| 1 | Name | Amount | Date | Doubled |")
		// Written formulas have no cached values — recalculated on open.
		expect(w.markdown).toContain("| 2 | alpha | 42.5 | 2024-01-01 | =B2*2 →  |")
		expect(w.markdown).toContain("| 3 | beta | -3 | 2025-12-31 | =B3*2 →  |")
		expect(w.markdown).toContain("| 4 | total | =SUM(B2:B3) →  |  | TRUE |")
	})

	it("is byte-identical across two runs with the clock pinned", async () => {
		const [a, b] = await Promise.all([writeXlsx(spec, { clock }), writeXlsx(spec, { clock })])
		expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true)
	})

	it("sets fullCalcOnLoad and no calcChain", async () => {
		const { bytes } = await writeXlsx(spec, { clock })
		const pkg = await openOoxml(bytes)
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml"))
		expect(wb).toContain('fullCalcOnLoad="1"')
		expect(pkg.hasXml("xl/calcChain.xml")).toBe(false)
	})

	it("freeze header and widths land in the sheet xml", async () => {
		const { bytes } = await writeXlsx(spec, { clock })
		const pkg = await openOoxml(bytes)
		const sheet = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet1.xml"))
		expect(sheet).toContain('state="frozen"')
		expect(sheet).toContain('<col min="1" max="1" width="24" customWidth="1"/>')
		expect(sheet).toContain('<dimension ref="A1:D4"/>')
	})

	it("rejects invalid sheet names and non-finite numbers", async () => {
		await expect(writeXlsx({ sheets: [{ name: "bad/name", rows: [[1]] }] }, { clock })).rejects.toMatchObject({
			code: "corrupt",
		})
		await expect(writeXlsx({ sheets: [{ name: "ok", rows: [[Number.NaN]] }] }, { clock })).rejects.toMatchObject({
			code: "corrupt",
		})
		await expect(
			writeXlsx(
				{
					sheets: [
						{ name: "one", rows: [[1]] },
						{ name: "ONE", rows: [[2]] },
					],
				},
				{ clock },
			),
		).rejects.toMatchObject({ code: "corrupt" })
	})

	it("formula-lint rejects unknown sheets and functions, prefixes _xlfn", async () => {
		await expect(writeXlsx({ sheets: [{ name: "S", rows: [[1, { f: "Nope!B2" }]] }] }, { clock })).rejects.toThrow(
			/unknown-sheet/,
		)
		await expect(
			writeXlsx({ sheets: [{ name: "S", rows: [[1, { f: "FROBNICATE(B2)" }]] }] }, { clock }),
		).rejects.toThrow(/unknown-function/)
		const { bytes, warnings } = await writeXlsx(
			{
				sheets: [
					{
						name: "S",
						rows: [[["a", "b"].length, { f: 'TEXTJOIN(",",TRUE,A1,B1)' }, { f: "XLOOKUP(A1,A1:B1,B1:B1)" }]],
					},
				],
			},
			{ clock },
		)
		expect(warnings.some((w) => w.includes("XLOOKUP"))).toBe(true)
		const pkg = await openOoxml(bytes)
		const sheet = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet1.xml"))
		expect(sheet).toContain("_xlfn.TEXTJOIN")
		expect(sheet).toContain("_xlfn.XLOOKUP")
	})

	it("warns on out-of-range refs but still writes", async () => {
		const { warnings } = await writeXlsx({ sheets: [{ name: "S", rows: [[1, { f: "SUM(A1:A99)" }]] }] }, { clock })
		expect(warnings.some((w) => w.includes("out-of-range-ref"))).toBe(true)
	})

	it("cross-sheet refs to existing sheets pass lint", async () => {
		const { warnings } = await writeXlsx(
			{
				sheets: [
					{ name: "Scratch", rows: [[5]] },
					{ name: "Main", rows: [[1, { f: "Scratch!A1*2" }]] },
				],
			},
			{ clock },
		)
		expect(warnings).toEqual([])
	})
})
