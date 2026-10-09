import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import { makeScannedPdf, makeSimplePdf, makeSimplePptx } from "./fixtures/builders.js"
import { createReadDocumentTool, selectUnits, stripLocators } from "./read-tool.js"
import { loadPdfium } from "./render-pages.js"

function depsFor(fixtures: Record<string, Uint8Array>) {
	return {
		readFileData: async (absolute: string) => {
			const hit = fixtures[absolute]
			if (!hit) throw new Error(`ENOENT: ${absolute}`)
			return hit
		},
	}
}

async function run(
	fixtures: Record<string, Uint8Array>,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> | null }> {
	const t = createReadDocumentTool(depsFor(fixtures))
	const res = await t.execute("c1", params as never, undefined as never, undefined as never, { cwd: "/w" } as never)
	return {
		text: res.content[0].type === "text" ? res.content[0].text : "",
		details: (res.details as Record<string, unknown> | null) ?? null,
	}
}

function makeWorkbook(build: (wb: XLSX.WorkBook) => void): Uint8Array {
	const wb = XLSX.utils.book_new()
	build(wb)
	return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

describe("read_document tool", () => {
	it("reads a whole small pdf", async () => {
		const out = await run({ "/w/r.pdf": await makeSimplePdf() }, { path: "/w/r.pdf" })
		expect(out.text).toContain("# r.pdf (pdf — 2 pages)")
		expect(out.text).toContain("Hello from page one")
		expect(out.details).toMatchObject({ format: "pdf", totalUnits: 2, selectedUnits: 2 })
	})

	it("selects slides via pages range", async () => {
		const out = await run({ "/w/d.pptx": await makeSimplePptx() }, { path: "/w/d.pptx", pages: "2-3" })
		expect(out.text).toContain("2 of 3")
		expect(out.text).toContain("Closing remarks")
		expect(out.text).not.toContain("Kickoff")
	})

	it("rejects an unparseable pages range", async () => {
		const out = await run({ "/w/r.pdf": await makeSimplePdf() }, { path: "/w/r.pdf", pages: "banana" })
		expect(out.details?.errorCode).toBe("invalid-selection")
		expect(out.text).toContain('Could not parse unit range "banana"')
	})

	it("selects a sheet by name; an absent name lists the sheets", async () => {
		const data = makeWorkbook((wb) => {
			XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", 1]]), "Totals")
			XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["b", 2]]), "Detail")
		})
		const out = await run({ "/w/wb.xlsx": data }, { path: "/w/wb.xlsx", sheet: "Detail" })
		expect(out.text).toContain("Sheet: Detail")
		const missing = await run({ "/w/wb.xlsx": data }, { path: "/w/wb.xlsx", sheet: "Nope" })
		expect(missing.details?.errorCode).toBe("invalid-selection")
		expect(missing.text).toContain("Sheets: Totals, Detail")
	})

	it("slices rows of a sheet table", async () => {
		const data = makeWorkbook((wb) => {
			XLSX.utils.book_append_sheet(
				wb,
				XLSX.utils.aoa_to_sheet([
					["h1", "h2"],
					[1, 2],
					[3, 4],
					[7, 8],
				]),
				"S",
			)
		})
		const out = await run({ "/w/wb.xlsx": data }, { path: "/w/wb.xlsx", rows: "2-3" })
		expect(out.text).toContain("| 2 | 1 | 2 |")
		expect(out.text).toContain("| 3 | 3 | 4 |")
		// Row 4 must be gone (line-anchored: row 3 legitimately contains cell 4)
		expect(out.text).not.toMatch(/\n\| 4 \|/)
	})

	it("shows formulas on xlsx when asked", async () => {
		const data = makeWorkbook((wb) => {
			const ws = XLSX.utils.aoa_to_sheet([
				["a", 1],
				["sum", 0],
			])
			ws["B2"] = { t: "n", f: "SUM(B1:B1)", v: 1, w: "1" }
			ws["!ref"] = "A1:B2"
			XLSX.utils.book_append_sheet(wb, ws, "S")
		})
		const out = await run({ "/w/wb.xlsx": data }, { path: "/w/wb.xlsx", formulas: true })
		expect(out.text).toContain("=SUM(B1:B1)")
	})

	it("attaches page images for a scanned PDF when the model accepts images", async () => {
		if (!(await loadPdfium()).pdfium) return // exotic env; degradation is covered in render-pages.test
		const t = createReadDocumentTool(depsFor({ "/w/s.pdf": await makeScannedPdf() }))
		const res = await t.execute(
			"c1",
			{ path: "/w/s.pdf" } as never,
			undefined as never,
			undefined as never,
			{
				cwd: "/w",
				model: { provider: "p", id: "v", input: ["text", "image"] },
			} as never,
		)
		const kinds = res.content.map((b) => b.type)
		expect(kinds.filter((k) => k === "image")).toHaveLength(2)
		const text = res.content[0].type === "text" ? res.content[0].text : ""
		expect(text).toContain("[page-images] 2 scanned page(s)")
	})

	it("keeps warning-only output for a scanned PDF on a text-only model", async () => {
		const t = createReadDocumentTool(depsFor({ "/w/s.pdf": await makeScannedPdf() }))
		const res = await t.execute(
			"c1",
			{ path: "/w/s.pdf" } as never,
			undefined as never,
			undefined as never,
			{
				cwd: "/w",
				model: { provider: "p", id: "t", input: ["text"] },
			} as never,
		)
		expect(res.content.every((b) => b.type === "text")).toBe(true)
		const text = res.content[0].type === "text" ? res.content[0].text : ""
		expect(text).toContain("no text layer")
		expect(text).not.toContain("[page-images]")
	})

	it("maps typed extraction failures to error results", async () => {
		const out = await run({ "/w/bad.pdf": new TextEncoder().encode("%PDF- junk") }, { path: "/w/bad.pdf" })
		expect(out.details?.errorCode).toBe("corrupt")
		expect(out.text).toContain("read_document failed")
	})

	it("strips locators when locators=false", async () => {
		expect(stripLocators('[table 1]\n| a |\n[shape "T"]\ntext [chart]\n')).not.toContain("[table 1]")
		expect(stripLocators('[shape "T"]\ncontent')).toContain("content")
		const pptx = await run({ "/w/d.pptx": await makeSimplePptx() }, { path: "/w/d.pptx", pages: "1", locators: false })
		expect(pptx.text).not.toContain('[shape "Title 1"]')
		expect(pptx.text).toContain("Kickoff")
	})
})

describe("selectUnits", () => {
	const doc = {
		format: "pdf" as const,
		unitKind: "page" as const,
		units: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, label: `Page ${i + 1}`, markdown: "" })),
		outline: [],
		notes: [],
	}
	it("caps default selection at 20 units", () => {
		expect(selectUnits(doc, {}).indices).toHaveLength(20)
	})
	it("errors when a requested range exceeds 20 units", () => {
		expect(selectUnits(doc, { pages: "1-25" }).error).toMatch(/at most 20/)
	})
})
