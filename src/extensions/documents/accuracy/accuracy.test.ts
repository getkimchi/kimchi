/**
 * Read accuracy over the synthetic fixture corpus. Thresholds from the plan:
 *   - Synthetic Office: CER ≤ 0.5%, cells/headings 100%, τ = 1
 *   - Digital PDF:      CER ≤ 1%,   τ = 1 (single-column fixtures)
 * Real-app and adversarial corpora land here in later phases.
 */

import { describe, expect, it } from "vitest"
import { extractDocument } from "../extract.js"
import { makePdfWithBlankPage, makeSimpleDocx, makeSimplePdf, makeSimplePptx } from "../fixtures/builders.js"
import { cer, kendallTau, tableCellAccuracy, wordF1 } from "./score.js"

describe("read accuracy (synthetic corpus)", () => {
	it("pdf: CER ≤ 1%, τ = 1", async () => {
		const doc = await extractDocument("t.pdf", await makeSimplePdf())
		const text = doc.units.map((u) => u.markdown).join("\n")
		const truth = "Hello from page one Second page content"
		expect(cer(truth, text)).toBeLessThanOrEqual(0.01)
		expect(kendallTau(["Hello", "Second"], lookupOrder(text, ["Hello", "Second"]))).toBe(1)
	})

	it("pdf: blank page detection doesn't count as content", async () => {
		const doc = await extractDocument("t.pdf", await makePdfWithBlankPage())
		expect(doc.notes).toContain("page 1 has no text layer")
		expect(cer("Only this page has text", doc.units[1].markdown)).toBeLessThanOrEqual(0.01)
	})

	it("docx: CER ≤ 0.5%, headings and cells at 100%, τ = 1", async () => {
		const doc = await extractDocument("t.docx", await makeSimpleDocx())
		const md = doc.units[0].markdown
		const truth = "Quarterly Report Revenue grew in Q3 across all regions. Region Amount North 42"
		expect(cer(truth, extractWordsOnly(md))).toBeLessThanOrEqual(0.005)
		expect(wordF1(truth, extractWordsOnly(md))).toBeGreaterThanOrEqual(0.98)
		expect(doc.outline).toContain("# Quarterly Report")
		expect(tableCellAccuracy(["Region", "Amount", "North", "42"], md)).toBe(1)
		expect(kendallTau(["Quarterly", "Revenue", "North"], lookupOrder(md, ["Quarterly", "Revenue", "North"]))).toBe(1)
	})

	it("pptx: every slide's text present, slide order preserved", async () => {
		const doc = await extractDocument("t.pptx", await makeSimplePptx())
		const text = doc.units.map((u) => u.markdown).join("\n")
		expect(
			tableCellAccuracy(
				["Kickoff", "Agenda items", "Closing remarks", "H1", "H2", "C1", "C2", "Remember to thank sponsors"],
				text,
			),
		).toBe(1)
		// sldIdLst order 1-3-2: Kickoff before Closing remarks before the table cells
		expect(kendallTau(["Kickoff", "Closing", "H1"], lookupOrder(text, ["Kickoff", "Closing", "H1"]))).toBe(1)
	})

	it("xlsx: cell accuracy 100%, values formatted from format codes", async () => {
		const XLSX = await import("xlsx")
		const wb = XLSX.utils.book_new()
		const ws = XLSX.utils.aoa_to_sheet([
			["Name", "Amount"],
			["North", 42],
			["South", 7],
		])
		XLSX.utils.book_append_sheet(wb, ws, "Totals")
		const data = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
		const doc = await extractDocument("t.xlsx", data)
		expect(tableCellAccuracy(["Name", "Amount", "North", "42", "South", "7"], doc.units[0].markdown)).toBe(1)
	})
})

function lookupOrder(text: string, items: string[]): string[] {
	return items.map((item) => item).sort((a, b) => text.indexOf(a) - text.indexOf(b))
}

function extractWordsOnly(markdown: string): string {
	return markdown
		.replace(/\[table \d+\]/g, " ")
		.replace(/[|#-]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
}
