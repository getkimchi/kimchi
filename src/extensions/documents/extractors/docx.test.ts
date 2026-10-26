import { describe, expect, it } from "vitest"
import { makeCustomDocx, makeOfficeShapedDocx, makeSimpleDocx } from "../fixtures/builders.js"
import { DocumentError } from "../model.js"
import { extractDocx } from "./docx.js"

describe("extractDocx", () => {
	it("extracts headings, paragraphs, lists, tables, tracked changes, comments and footnotes", async () => {
		const doc = await extractDocx(await makeSimpleDocx())
		expect(doc.totalBlocks).toBe(9)
		expect(doc.tables).toBe(1)
		expect(doc.info.trackedChanges).toBe(true)
		expect(doc.info.comments).toBe(1)
		expect(doc.info.footnotes).toBe(1)
		expect(doc.info.creator).toBe("kimchi-tests")

		const w = doc.window({ start: 1, end: 9 })
		expect(w.truncated).toBe(false)
		const lines = w.markdown.split("\n")
		expect(lines).toContain("p1: # Quarterly Report")
		expect(lines).toContain("p2: Revenue grew in Q3.")
		expect(lines).toContain("p3: - First bullet")
		expect(lines).toContain("p4:   - Nested bullet")
		expect(lines).toContain("p5: Inserted sentence.")
		expect(lines).toContain("> [inserted by Alice]")
		expect(lines).toContain("> [deleted by Bob]")
		expect(lines).toContain("p7: Commented phrase")
		expect(lines).toContain("> [comment 0] Alice (2026-01-01): Fix this.")
		expect(lines.some((l) => l.startsWith("[table 1]"))).toBe(true)
		expect(lines).toContain("| A1 | B1 |")
		expect(lines).toContain("| A2 | B2 |")
		expect(w.markdown).toContain("With footnote[^1]")
		expect(w.markdown).toContain("### Footnotes")
		expect(w.markdown).toContain("[^1]: Source: internal data.")
	})

	it("reads a Word 2010+ shaped document (w14/mc/AlternateContent namespaces)", async () => {
		const doc = await extractDocx(await makeOfficeShapedDocx())
		expect(doc.totalBlocks).toBe(4)
		expect(doc.tables).toBe(1)
		expect(doc.outline).toEqual(["b1: # Board Pack"])
		const w = doc.window({ start: 1, end: 4 })
		expect(w.truncated).toBe(false)
		const lines = w.markdown.split("\n")
		expect(lines).toContain("p1: # Board Pack")
		expect(lines).toContain("p2: Quarterly review.")
		expect(lines.some((l) => l.includes("text box words"))).toBe(true)
		expect(lines).toContain("| Board | Seats |")
		expect(lines).toContain("| Custos | 12 |")
	})

	it("produces a whole-document outline of headings with block locators", async () => {
		const doc = await extractDocx(await makeSimpleDocx())
		expect(doc.outline).toEqual(["b1: # Quarterly Report"])
	})

	it("windows by body-block numbers with a continuation boundary", async () => {
		const paras = Array.from(
			{ length: 60 },
			(_, i) => `<w:p><w:r><w:t>Paragraph number ${i + 1} with a bit of filler text.</w:t></w:r></w:p>`,
		).join("")
		const doc = await extractDocx(await makeCustomDocx(paras))
		expect(doc.totalBlocks).toBe(60)
		const w1 = doc.window({ start: 1, end: 10 })
		expect(w1.from).toBe(1)
		expect(w1.to).toBe(10)
		expect(w1.markdown).toContain("p1: Paragraph number 1")
		expect(w1.markdown).toContain("p10: Paragraph number 10")
		expect(w1.markdown).not.toContain("p11")

		const w2 = doc.window({ start: 55, end: 60 })
		expect(w2.markdown).toContain("p60: Paragraph number 60")
	})

	it("truncates at the character cap and points at the next block", async () => {
		const filler = "x".repeat(90)
		const paras = Array.from({ length: 20 }, (_, i) => `<w:p><w:r><w:t>${i + 1}-${filler}</w:t></w:r></w:p>`).join("")
		const doc = await extractDocx(await makeCustomDocx(paras))
		const w = doc.window({ start: 1, end: 20, maxChars: 500 })
		expect(w.truncated).toBe(true)
		expect(w.markdown.length).toBeLessThanOrEqual(600)
		expect(w.to).toBeGreaterThanOrEqual(1)
		expect(w.to).toBeLessThan(20)
	})

	it("skips empty paragraphs but keeps their numbering", async () => {
		const doc = await extractDocx(
			await makeCustomDocx(`
<w:p><w:r><w:t>One</w:t></w:r></w:p>
<w:p/>
<w:p><w:r><w:t xml:space="preserve">  </w:t></w:r></w:p>
<w:p><w:r><w:t>Four</w:t></w:r></w:p>`),
		)
		const w = doc.window()
		expect(w.markdown).toContain("p1: One")
		expect(w.markdown).toContain("p4: Four")
		expect(w.markdown).not.toContain("p2:")
		expect(w.markdown).not.toContain("p3:")
	})

	it("counts images and renders an [image] marker", async () => {
		const doc = await extractDocx(
			await makeCustomDocx(`
<w:p><w:r><w:t>Before picture:</w:t></w:r><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><a:blip r:embed="rId7" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`),
		)
		expect(doc.images).toBe(1)
		expect(doc.window().markdown).toContain("p1: Before picture:[image]")
	})

	it("rejects non-docx packages with a typed error", async () => {
		const { makeSimplePptx } = await import("../fixtures/builders.js")
		await expect(extractDocx(await makeSimplePptx())).rejects.toMatchObject({
			code: "corrupt",
			format: "docx",
		})
	})

	it("blockText addresses content by body-block number", async () => {
		const doc = await extractDocx(await makeSimpleDocx())
		expect(doc.blockText(2)).toBe("Revenue grew in Q3.")
		expect(doc.blockText(9)).toContain("A1")
		expect(() => doc.blockText(10)).toThrow(DocumentError)
	})
})

describe("extractDocx — adversarial", () => {
	it("rejects a docx with an oversized side part", async () => {
		const huge = "a".repeat(21 * 1024 * 1024)
		const docx = await makeCustomDocx("<w:p><w:r><w:t>x</w:t></w:r></w:p>", {
			"word/comments.xml": `<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="a">${huge}</w:comment></w:comments>`,
		})
		await expect(extractDocx(docx)).rejects.toMatchObject({ code: "safety-limit" })
	})

	it("rejects a document.xml without a body", async () => {
		const JSZip = (await import("jszip")).default
		const zip = new JSZip()
		zip.file(
			"word/document.xml",
			`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:document>`,
		)
		zip.file(
			"[Content_Types].xml",
			`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
		)
		await expect(extractDocx(await zip.generateAsync({ type: "uint8array" }))).rejects.toMatchObject({
			code: "corrupt",
			format: "docx",
		})
	})

	it("rejects a non-zip input at the package layer", async () => {
		await expect(extractDocx(new TextEncoder().encode("hello world, not a zip"))).rejects.toMatchObject({
			code: "corrupt",
		})
	})

	it("rejects an empty file at the package layer", async () => {
		await expect(extractDocx(new Uint8Array(0))).rejects.toMatchObject({ code: "corrupt" })
	})

	it("caps the outline at 200 headings", async () => {
		const paras = Array.from(
			{ length: 250 },
			(_, i) => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Section ${i}</w:t></w:r></w:p>`,
		).join("")
		const doc = await extractDocx(await makeCustomDocx(paras))
		expect(doc.outline.length).toBe(201) // 200 + cap marker
		expect(doc.outline[200]).toContain("capped at 200")
	})
})
