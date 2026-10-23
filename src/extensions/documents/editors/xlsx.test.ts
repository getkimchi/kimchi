import { describe, expect, it } from "vitest"
import { extractXlsx } from "../extractors/xlsx.js"
import { makeCustomXlsx, makeSimpleXlsx } from "../fixtures/builders.js"
import { openOoxml } from "../ooxml/package.js"
import { applyXlsxOps, type XlsxOp } from "./xlsx.js"

async function apply(data: Uint8Array, ops: XlsxOp[]) {
	const pkg = await openOoxml(data)
	const result = applyXlsxOps(pkg, ops)
	const bytes = await pkg.save()
	return { result, bytes, pkg: await openOoxml(bytes) }
}

describe("set-cells", () => {
	it("replaces values, keeps dates styled, and adds new rows", async () => {
		const { result, bytes } = await apply(await makeSimpleXlsx(), [
			{ kind: "set-cells", sheet: 1, cells: { B1: 9.75, A4: "new row", B4: 2, D1: { f: "B1+B4" } } },
		])
		expect(result.applied[0]).toContain("set-cells")
		expect(result.formulasWritten).toBe(1)
		const doc = await extractXlsx(bytes)
		const w = doc.window({ sheet: 1, startRow: 1, endRow: 4, showFormulas: true })
		expect(w.markdown).toContain("| 1 | padding cell | 9.75 | 2024-01-01 | =B1+B4 →  |")
		expect(w.markdown).toContain("| 4 | new row | 2 |  |  |")
	})

	it("rejects formats on edit and unknown sheets as one clear error", async () => {
		await expect(
			applyAwait(makeSimpleXlsx(), [{ kind: "set-cells", cells: { A1: { v: 1, fmt: "0.00%" } } }]),
		).rejects.toThrow(/number formats/)
		await expect(
			applyAwait(makeSimpleXlsx(), [{ kind: "set-cells", sheet: "Missing", cells: { A1: 1 } }]),
		).rejects.toThrow(/No sheet named/)
	})

	it("keeps untouched cells and arbitrary attributes byte-preserved", async () => {
		const { pkg } = await apply(await makeSimpleXlsx(), [{ kind: "set-cells", cells: { B1: 5 } }])
		const xml = new TextDecoder().decode(sheetXml(pkg))
		expect(xml).toContain('t="inlineStr"><is><t>inline note</t></is>')
		expect(xml).toContain('<mergeCell ref="B4:C4"/>')
	})
})

/** Sheet part bytes — test files have them or the fixture is wrong, fail loudly. */
function sheetXml(pkg: Awaited<ReturnType<typeof openOoxml>>): Uint8Array {
	const bytes = pkg.getBytes("xl/worksheets/sheet1.xml")
	if (!bytes) throw new Error("fixture sheet1.xml missing")
	return bytes
}

async function applyAwait(data: Promise<Uint8Array> | Uint8Array, ops: XlsxOp[]) {
	const pkg = await openOoxml(await data)
	applyXlsxOps(pkg, ops)
	return pkg.save()
}

describe("clear-range", () => {
	it("clears cells and updates the dimension", async () => {
		const { bytes } = await apply(await makeSimpleXlsx(), [{ kind: "clear-range", sheet: "Data", range: "A1:D2" }])
		const doc = await extractXlsx(bytes)
		const w = doc.window({ sheet: 1, startRow: 1, endRow: 3 })
		expect(w.markdown).toContain("| 1 |  |  |")
		expect(w.markdown).toContain("| 3 | #DIV/0! | -7 |")
		expect(w.markdown).not.toContain("padding cell")
	})

	it("refuses ranges intersecting merged cells", async () => {
		await expect(applyAwait(makeSimpleXlsx(), [{ kind: "clear-range", range: "B3:C5" }])).rejects.toThrow(
			/merged cells/,
		)
	})
})

describe("append-rows", () => {
	it("appends after the last row", async () => {
		const { bytes } = await apply(await makeSimpleXlsx(), [
			{ kind: "append-rows", rows: [["tail", 1, { f: "SUM(B1:B4)" }]] },
		])
		const doc = await extractXlsx(bytes)
		const w = doc.window({ sheet: 1, startRow: 3, endRow: 5, showFormulas: true })
		expect(w.markdown).toContain("| 4 | tail | 1 | =SUM(B1:B4) →  |")
	})
})

describe("set-column-width", () => {
	it("writes <cols> into the part", async () => {
		const { pkg } = await apply(await makeSimpleXlsx(), [{ kind: "set-column-width", columns: { B: 20 } }])
		const xml = new TextDecoder().decode(sheetXml(pkg))
		expect(xml).toContain('<col min="2" max="2" width="20" customWidth="1"/>')
	})
})

describe("fill-formula", () => {
	it("expands {col}/{row} over the range and drops calcChain", async () => {
		const data = await makeCustomXlsx([
			{
				name: "F",
				inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row></sheetData>`,
			},
		])
		const pkg0 = await openOoxml(data)
		pkg0.putBytes("xl/calcChain.xml", new TextEncoder().encode("<calcChain/>"))
		const seeded = await pkg0.save()

		const { result, pkg } = await apply(seeded, [
			{ kind: "fill-formula", sheet: 1, range: "B1:B2", formula: "A{row}*10" },
		])
		expect(result.formulasWritten).toBe(2)
		expect(result.formulasAlert).toBe(true)
		const sheet = new TextDecoder().decode(sheetXml(pkg))
		expect(sheet).toContain("<f>A1*10</f>")
		expect(sheet).toContain("<f>A2*10</f>")
		expect(sheet).not.toContain("<v>2</v>") // stale cached value removed
		expect(pkg.hasXml("xl/calcChain.xml")).toBe(false)
		const wbBytes = pkg.getBytes("xl/workbook.xml")
		if (!wbBytes) throw new Error("workbook.xml missing")
		const wb = new TextDecoder().decode(wbBytes)
		expect(wb).toContain('fullCalcOnLoad="1"')
	})
})

describe("add-sheet", () => {
	it("adds the part, rels, types and workbook entry", async () => {
		const { result, bytes, pkg } = await apply(await makeSimpleXlsx(), [
			{ kind: "add-sheet", name: "New", rows: [["a"], [1]] },
		])
		expect(result.applied[0]).toContain('add-sheet: "New"')
		const doc = await extractXlsx(bytes)
		expect(doc.sheets.map((s) => s.name)).toEqual(["Data", "Scratch", "New"])
		expect(pkg.hasXml("xl/worksheets/sheet3.xml")).toBe(true)
	})

	it("rejects duplicate names", async () => {
		await expect(applyAwait(makeSimpleXlsx(), [{ kind: "add-sheet", name: "data", rows: [] }])).rejects.toThrow(
			/already exists/,
		)
	})
})

describe("package preservation", () => {
	it("untouched parts survive a save", async () => {
		const before = await openOoxml(await makeSimpleXlsx())
		const marker = new TextEncoder().encode("marker binary")
		before.putBytes("xl/embeddings/note.bin", marker)
		const seeded = await before.save()
		const { pkg } = await apply(seeded, [{ kind: "set-cells", cells: { A1: "x" } }])
		const got = pkg.getBytes("xl/embeddings/note.bin")
		expect(new TextDecoder().decode(got)).toBe("marker binary")
		const styles = pkg.getBytes("xl/styles.xml")
		expect(styles).toBeDefined()
	})
})

describe("review fixes", () => {
	it("drops a hostile s= attribute instead of re-emitting it", async () => {
		const data = await makeCustomXlsx([
			{
				name: "S",
				inner: `<sheetData><row r="1"><c r="A1" s="1\x22/>\x3cev:x \x66oo=\x22"><v>7</v></c></row></sheetData>`,
			},
		])
		const { pkg } = await apply(data, [{ kind: "set-cells", cells: { A1: 8 } }])
		const xml = new TextDecoder().decode(sheetXml(pkg))
		expect(xml).not.toContain("ev:x")
		// The digit-only part of the preserved style survives; the payload after the
		// closing quote never reaches an attribute — and nothing is re-emitted raw.
		expect(xml).toContain('<c r="A1" s="1"><v>8</v></c>')
	})

	it("rejects non-numeric set-column-width and extreme values", async () => {
		await expect(
			applyAwait(makeSimpleXlsx(), [
				{ kind: "set-column-width", columns: { A: '12"/><x' } as unknown as Record<string, number> },
			]),
		).rejects.toThrow(/width must be a finite number/)
		await expect(applyAwait(makeSimpleXlsx(), [{ kind: "set-column-width", columns: { A: 9999 } }])).rejects.toThrow(
			/width must be a finite number/,
		)
	})

	it("rename-sheet updates the workbook entry and formula references, re-quoted and escaped", async () => {
		const { bytes } = await apply(
			await makeCustomXlsx([
				{ name: "Data", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{
					name: "Calc",
					inner: `<sheetData><row r="1"><c r="A1"><f>Data!A1*2</f><v>2</v></c><c r="B1"><f>'Data'!$A$1+1</f><v>2</v></c></row></sheetData>`,
				},
			]),
			[{ kind: "rename-sheet", sheet: "Data", name: "Raw Data" }],
		)
		const pkg = await openOoxml(bytes)
		const calc = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet2.xml")!)
		expect(calc).toContain("<f>'Raw Data'!A1*2</f>") // renamed names needing quoting are quoted
		expect(calc).toContain("<f>'Raw Data'!$A$1+1</f>")
		const doc = await extractXlsx(bytes)
		expect(doc.sheets.map((s) => s.name)).toEqual(["Raw Data", "Calc"])
	})

	it("rename-sheet to an &-name produces a valid workbook", async () => {
		const { bytes } = await apply(
			await makeCustomXlsx([
				{ name: "Data", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{
					name: "Calc",
					inner: `<sheetData><row r="1"><c r="A1"><f>Data!A1*2</f><v>2</v></c></row></sheetData>`,
				},
			]),
			[{ kind: "rename-sheet", sheet: "Data", name: "R&D 2026" }],
		)
		const pkg = await openOoxml(bytes)
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).toContain(`name="R&amp;D 2026"`)
		const calc = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet2.xml")!)
		expect(calc).toContain(`<f>'R&amp;D 2026'!A1*2</f>`)
		// and the whole workbook reads back cleanly
		const doc = await extractXlsx(bytes)
		expect(doc.sheets.map((s) => s.name)).toEqual(["R&D 2026", "Calc"])
		expect(doc.window({ sheet: "Calc" }).markdown).toContain("| 1 | 2 |")
	})

	it("rename-sheet leaves cell text alone", async () => {
		const { pkg } = await apply(
			await makeCustomXlsx([
				{
					name: "Data",
					inner: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Data!A1 is a label</t></is></c></row></sheetData>`,
				},
				{
					name: "Calc",
					inner: `<sheetData>
<row r="1"><c r="A1"><f>Data!A1</f><v>1</v></c></row>`,
				},
			]),
			[{ kind: "rename-sheet", sheet: "Data", name: "Raw Data" }],
		)
		const data = new TextDecoder().decode(sheetXml(pkg))
		expect(data).toContain("Data!A1 is a label")
		const calc = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet2.xml")!)
		expect(calc).toContain("<f>'Raw Data'!A1</f>")
	})

	it("rename-sheet allows a case-only rename (duplicate check excludes itself)", async () => {
		const { pkg } = await apply(await makeSimpleXlsx(), [{ kind: "rename-sheet", sheet: "Data", name: "DATA" }])
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).toContain('name="DATA"')
	})

	it("rename-sheet rejects duplicates and bad names", async () => {
		await expect(
			applyAwait(makeSimpleXlsx(), [{ kind: "rename-sheet", sheet: "Scratch", name: "data" }]),
		).rejects.toThrow(/already exists/)
		await expect(
			applyAwait(makeSimpleXlsx(), [{ kind: "rename-sheet", sheet: "Scratch", name: "bad/name" }]),
		).rejects.toThrow(/forbidden character|bad sheet name/)
		await expect(
			applyAwait(makeSimpleXlsx(), [{ kind: "rename-sheet", sheet: "Scratch", name: "History" }]),
		).rejects.toThrow(/reserved/)
	})

	it("rename-sheet updates defined names, charts, pivot sources, conditional formats and validations", async () => {
		const data = await makeCustomXlsx(
			[
				{ name: "Data", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{
					name: "Calc",
					inner: `<sheetData>
<conditionalFormatting sqref="A1"><cfRule><formula>Data!A1&gt;0</formula></cfRule></conditionalFormatting>
<dataValidations count="1"><dataValidation sqref="B1"><formula1>Data!A1</formula1><formula2>3</formula2></dataValidation></dataValidations>`,
				},
			],
			{
				workbookAfterSheets: `<definedNames>
<definedName name="Sales">Data!$A$1</definedName>
<definedName name="Local" localSheetId="1">Data!$B$2</definedName>
<definedName name="Literal">"Data!text"</definedName>
</definedNames>`,
				extraParts: {
					"xl/charts/chart1.xml": `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:ser><c:f>Data!$A$1</c:f><c:strCache><c:pt idx="0"><c:v>Data!</c:v></c:pt></c:strCache></c:ser></c:plotArea></c:chart></c:chartSpace>`,
					"xl/pivotCache/pivotCacheDefinition1.xml": `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><cacheSource><worksheetSource sheet="Data" ref="A1:K9"/></cacheSource></pivotCacheDefinition>`,
				},
				extraContentTypes: `  <Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>
  <Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>`,
				extraWorkbookRels: `  <Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart1.xml"/>
  <Relationship Id="rIdP1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>`,
			},
		)
		const { pkg } = await apply(data, [{ kind: "rename-sheet", sheet: "Data", name: "Raw Data" }])
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).toContain(`<definedName name="Sales">'Raw Data'!$A$1</definedName>`)
		expect(wb).toContain(`<definedName name="Literal">"Data!text"</definedName>`) // string literal untouched
		const calc = new TextDecoder().decode(pkg.getBytes("xl/worksheets/sheet2.xml")!)
		expect(calc).toContain(`<formula>'Raw Data'!A1&gt;0</formula>`)
		expect(calc).toContain(`<formula1>'Raw Data'!A1</formula1>`)
		expect(calc).toContain("<formula2>3</formula2>")
		const chart = new TextDecoder().decode(pkg.getBytes("xl/charts/chart1.xml")!)
		expect(chart).toContain(`<c:f>'Raw Data'!$A$1</c:f>`)
		expect(chart).toContain("<c:v>Data!</c:v>") // cache VALUES are not formulas
		const pivot = new TextDecoder().decode(pkg.getBytes("xl/pivotCache/pivotCacheDefinition1.xml")!)
		expect(pivot).toContain(`sheet="Raw Data"`)
	})

	it("delete-sheet removes the part, rel, workbook and content-types entries", async () => {
		const { bytes, pkg } = await apply(await makeSimpleXlsx(), [{ kind: "delete-sheet", sheet: "Scratch" }])
		expect(pkg.getBytes("xl/worksheets/sheet2.xml")).toBeUndefined()
		const doc = await extractXlsx(bytes)
		expect(doc.sheets.map((s) => s.name)).toEqual(["Data"])
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).not.toContain("Scratch")
		const ct = new TextDecoder().decode(pkg.getBytes("[Content_Types].xml")!)
		expect(ct).not.toContain("sheet2.xml")
	})

	it("delete-sheet refuses when another sheet's formulas reference it, naming the referrer", async () => {
		await expect(
			applyAwait(
				makeCustomXlsx([
					{ name: "Data", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
					{ name: "Scratch", inner: `<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>` },
					{
						name: "Ref",
						inner: `<sheetData><row r="1"><c r="A1"><f>Data!A1+Scratch!A1</f><v>3</v></c></row></sheetData>`,
					},
				]),
				[{ kind: "delete-sheet", sheet: "Scratch" }],
			),
		).rejects.toThrow(/referenced by "sheet Ref"/)
	})

	it("delete-sheet is refused when a defined name or a chart references the sheet", async () => {
		const build = () =>
			makeCustomXlsx(
				[
					{ name: "Scratch", inner: `<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>` },
					{ name: "Keep", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				],
				{
					workbookAfterSheets: `<definedNames><definedName name="Totals">Scratch!$A$1+Keep!$A$1</definedName></definedNames>`,
					extraParts: {
						"xl/charts/chart1.xml": `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:f>Scratch!$A$1</c:f></c:chartSpace>`,
					},
					extraContentTypes: `  <Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
				},
			)
		await expect(applyAwait(build(), [{ kind: "delete-sheet", sheet: "Scratch" }])).rejects.toThrow(
			/"defined name Totals"/,
		)
		await expect(applyAwait(build(), [{ kind: "delete-sheet", sheet: "Scratch" }])).rejects.toThrow(/chart/)
	})

	it("delete-sheet is NOT refused for a cell text mention", async () => {
		const { pkg } = await apply(
			await makeCustomXlsx([
				{ name: "Scratch", inner: `<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>` },
				{
					name: "Keep",
					inner: `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Scratch!A1 is mentioned in prose</t></is></c></row></sheetData>`,
				},
			]),
			[{ kind: "delete-sheet", sheet: "Scratch" }],
		)
		expect(pkg.getBytes("xl/worksheets/sheet1.xml")).toBeUndefined()
	})

	it("delete-sheet with an absolute rel target leaves no dangling rel", async () => {
		const data = await makeCustomXlsx(
			[
				{ name: "Keep", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{ name: "Scratch", inner: `<sheetData><row r="1"><c r="A1"><v>2</v></c></row></sheetData>` },
			],
			{ absoluteSheetTargets: true },
		)
		const { pkg } = await apply(data, [{ kind: "delete-sheet", sheet: "Scratch" }])
		const rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels")!)
		expect(rels).not.toContain("rId2")
		expect(rels).toContain('Id="rId1"')
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).not.toContain("Scratch")
	})

	it("delete-sheet drops names scoped to it and renumber localSheetId for the rest", async () => {
		const data = await makeCustomXlsx(
			[
				{ name: "A", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{ name: "B", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
				{ name: "C", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
			],
			{
				workbookAfterSheets: `<definedNames>
<definedName name="OnB" localSheetId="1">B!$A$1</definedName>
<definedName name="OnC" localSheetId="2">C!$A$1</definedName>
</definedNames>`,
				extraWorkbookRels: "",
			},
		)
		const { pkg } = await apply(data, [{ kind: "delete-sheet", sheet: "B" }])
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		expect(wb).not.toContain("OnB")
		expect(wb).toContain(`localSheetId="1"`) // C became index 1
	})

	it("delete-sheet + add-sheet keeps sheetIds unique", async () => {
		const data = await makeCustomXlsx([
			{ name: "A", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
			{ name: "B", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
			{ name: "C", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` },
		])
		const { pkg } = await apply(data, [
			{ kind: "delete-sheet", sheet: "B" },
			{ kind: "add-sheet", name: "D" },
		])
		const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml")!)
		const ids = [...wb.matchAll(/sheetId="(\d+)"/g)].map((m) => m[1])
		expect(new Set(ids).size).toBe(ids.length)
		expect(ids).toContain("4") // D takes max+1, never reuses 2
	})

	it("soft lint findings surface as warnings while hard ones fail", async () => {
		const { result } = await apply(await makeSimpleXlsx(), [
			{ kind: "set-cells", cells: { E9: { f: "SUM(A1:A99999)" }, B3: 1 } },
		])
		expect(result.warnings.some((w) => w.includes("out-of-range-ref"))).toBe(true)
	})
})
