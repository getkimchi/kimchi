import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"
import { describe, expect, it } from "vitest"
import { isDocumentError } from "../model.js"
import { extractPdf, pdfInfo } from "./pdf.js"

async function makePdf(pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of pages) {
		const page = doc.addPage([400, 300])
		const lines = text.split("\n")
		for (const [i, line] of lines.entries()) {
			page.drawText(line, { x: 20, y: 260 - i * 16, size: 12, font })
		}
	}
	return doc.save().then((b) => new Uint8Array(b))
}

describe("extractPdf", () => {
	it("extracts each page as a Page N unit", async () => {
		const data = await makePdf(["hello page one", "page two here"])
		const doc = await extractPdf(data)
		expect(doc.format).toBe("pdf")
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].label).toBe("Page 1")
		expect(doc.units[0].markdown).toContain("hello page one")
		expect(doc.units[1].markdown).toContain("page two here")
		expect(doc.meta?.pageCount).toBe(2)
	})

	it("honors a page filter", async () => {
		const data = await makePdf(["one", "two", "three"])
		const doc = await extractPdf(data, { pages: [2, 3] })
		expect(doc.units.map((u) => u.index)).toEqual([2, 3])
	})

	it("flags pages with no text layer without failing the document", async () => {
		const withText = await makePdf(["has text"])
		const imageOnly = await (async () => {
			const doc = await PDFDocument.create()
			doc.addPage([200, 100])
			return new Uint8Array(await doc.save())
		})()
		const merged = await PDFDocument.create()
		for (const src of [withText, imageOnly]) {
			const d = await PDFDocument.load(src)
			const [p] = await merged.copyPages(d, [0])
			merged.addPage(p)
		}
		const doc = await extractPdf(new Uint8Array(await merged.save()))
		expect(doc.notes).toEqual(["page 2 has no text layer"])
		expect(doc.units[0].markdown).toContain("has text")
	})

	it("throws extraction-failed when every page lacks a text layer", async () => {
		const doc = await PDFDocument.create()
		doc.addPage([200, 100])
		const data = new Uint8Array(await doc.save())
		try {
			await extractPdf(data)
			expect.unreachable()
		} catch (err) {
			expect(isDocumentError(err)).toBe(true)
			expect((err as { code: string }).code).toBe("extraction-failed")
			expect((err as Error).message).toContain("scanned")
		}
	})

	it("rejects non-PDF bytes", async () => {
		try {
			await extractPdf(new TextEncoder().encode("hello world, not a pdf at all"))
			expect.unreachable()
		} catch (err) {
			expect((err as { code: string }).code).toBe("not-a-document")
		}
	})

	it("rejects corrupt PDFs with a typed error", async () => {
		const corrupt = new TextEncoder().encode("%PDF-1.4 this is not really a pdf 0123456789")
		try {
			await extractPdf(corrupt)
			expect.unreachable()
		} catch (err) {
			expect(isDocumentError(err)).toBe(true)
			expect((err as { code: string }).code).toBe("corrupt")
		}
	})

	it("keeps the caller's buffer usable after extraction (no pdf.js detachment)", async () => {
		const data = await makePdf(["detach guard"])
		const before = data.slice(0, 8)
		await extractPdf(data)
		expect(data.slice(0, 8)).toEqual(before)
		expect(data.length).toBeGreaterThan(100)
	})
})

describe("pdfInfo", () => {
	it("reports page count", async () => {
		const data = await makePdf(["a", "b", "c"])
		expect(await pdfInfo(data)).toEqual({ pageCount: 3, encrypted: false })
	})

	it("rejects non-PDF bytes", async () => {
		await expect(pdfInfo(new TextEncoder().encode("nope not pdf"))).rejects.toMatchObject({ code: "not-a-document" })
	})
})
