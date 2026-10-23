import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { detectDocumentFormat, isDocumentPath } from "./detect.js"
import { DocumentError } from "./model.js"

async function zipWith(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
	const zip = new JSZip()
	for (const [name, content] of Object.entries(entries)) zip.file(name, content)
	return zip.generateAsync({ type: "uint8array" })
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n...some bytes...\n%%EOF")
const OLE2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

describe("detectDocumentFormat", () => {
	it("detects PDF by magic even with a misleading extension", async () => {
		const detection = await detectDocumentFormat("report.txt", PDF_BYTES)
		expect(detection).toEqual({ format: "pdf", reason: "magic" })
	})

	it("detects DOCX by package parts", async () => {
		const data = await zipWith({ "word/document.xml": "<w:document/>", "[Content_Types].xml": "<Types/>" })
		expect(await detectDocumentFormat("x.pdf", data)).toEqual({ format: "docx", reason: "zip-parts" })
	})

	it("detects XLSX and PPTX by package parts", async () => {
		expect(await detectDocumentFormat("a.bin", await zipWith({ "xl/workbook.xml": "<workbook/>" }))).toEqual({
			format: "xlsx",
			reason: "zip-parts",
		})
		expect(await detectDocumentFormat("a.bin", await zipWith({ "ppt/presentation.xml": "<p:presentation/>" }))).toEqual(
			{
				format: "pptx",
				reason: "zip-parts",
			},
		)
	})

	it("detects ODS by package parts", async () => {
		const data = await zipWith({ "content.xml": "<o/>", "META-INF/manifest.xml": "<m/>" })
		expect(await detectDocumentFormat("sheet.ods", data)).toEqual({ format: "ods", reason: "zip-parts" })
	})

	it("detects legacy XLS via OLE2 signature", async () => {
		expect(await detectDocumentFormat("old.xls", OLE2)).toEqual({ format: "xls", reason: "ole2-signature" })
	})

	it("rejects legacy .doc/.ppt with a typed unsupported-format error", async () => {
		await expect(detectDocumentFormat("old.doc", OLE2)).rejects.toMatchObject({
			name: "DocumentError",
			code: "unsupported-format",
		})
		await expect(detectDocumentFormat("old.ppt", OLE2)).rejects.toBeInstanceOf(DocumentError)
	})

	it("returns undefined for a zip that is not a document package", async () => {
		const data = await zipWith({ "random/file.txt": "hello" })
		expect(await detectDocumentFormat("x.zip", data)).toBeUndefined()
	})

	it("detects CSV/TSV by extension + text bytes", async () => {
		expect(await detectDocumentFormat("t.csv", new TextEncoder().encode("a,b\n1,2\n"))).toEqual({
			format: "csv",
			reason: "extension-text",
		})
		expect(await detectDocumentFormat("t.tsv", new TextEncoder().encode("a\tb\n1\t2\n"))).toBeDefined()
		expect(await detectDocumentFormat("t.csv", new Uint8Array([0, 1, 2, 3]))).toBeUndefined()
	})

	it("returns undefined for empty and unknown files", async () => {
		expect(await detectDocumentFormat("zero.bin", new Uint8Array())).toBeUndefined()
		expect(await detectDocumentFormat("x.ts", new TextEncoder().encode("const a = 1\n"))).toBeUndefined()
	})
})

describe("isDocumentPath", () => {
	it("matches every supported extension, plus legacy", () => {
		for (const p of [
			"a.pdf",
			"b.docx",
			"c.pptx",
			"d.xlsx",
			"e.xls",
			"f.docm",
			"g.xlsm",
			"h.pptm",
			"i.ods",
			"j.csv",
			"k.tsv",
		]) {
			expect(isDocumentPath(p), p).toBe(true)
		}
		expect(isDocumentPath("a.doc")).toBe(true)
		expect(isDocumentPath("a.ppt")).toBe(true)
	})
	it("rejects non-documents", () => {
		for (const p of ["a.ts", "b.png", "noext", ".hidden", "x.tar.gz"]) {
			expect(isDocumentPath(p), p).toBe(false)
		}
	})
})
