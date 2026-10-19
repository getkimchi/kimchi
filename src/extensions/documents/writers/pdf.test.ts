import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { extractPdf } from "../extractors/pdf.js"
import { parseMarkdownBlocks } from "../markdown/blocks.js"
import { isDocumentError } from "../model.js"
import { PAGE_SIZES, renderBlocksToPdf } from "./pdf.js"

const here = dirname(fileURLToPath(import.meta.url))

function fontBytes() {
	const dir = join(here, "../../../..", "node_modules", "dejavu-fonts-ttf", "ttf")
	if (!existsSync(join(dir, "DejaVuSans.ttf"))) throw new Error("dejavu-fonts-ttf not installed in tests")
	return {
		regular: new Uint8Array(readFileSync(join(dir, "DejaVuSans.ttf"))),
		bold: new Uint8Array(readFileSync(join(dir, "DejaVuSans-Bold.ttf"))),
		mono: new Uint8Array(readFileSync(join(dir, "DejaVuSansMono.ttf"))),
	}
}

describe("renderBlocksToPdf", () => {
	it("round-trips headings, bullets and a table through extractPdf", async () => {
		const blocks = parseMarkdownBlocks(`# Title here

A paragraph with **bold words** inside.

- first bullet
- second bullet

| K | V |
|---|---|
| a | 1 |
| b | 2 |
`)
		const pdf = await renderBlocksToPdf(blocks, fontBytes())
		const doc = await extractPdf(pdf)
		const text = doc.units.map((u) => u.markdown).join("\n")
		expect(text).toContain("Title here")
		expect(text).toContain("bold words")
		expect(text).toContain("first bullet")
		expect(text).toContain("second bullet")
	})

	it("pagebreaks create separate pages", async () => {
		const blocks = parseMarkdownBlocks(`# One

---

# Two`)
		const pdf = await renderBlocksToPdf(blocks, fontBytes())
		const doc = await extractPdf(pdf)
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].markdown).toContain("One")
		expect(doc.units[1].markdown).toContain("Two")
	})

	it("renders Unicode beyond Latin-1 (the standard-14 failure mode)", async () => {
		const blocks = parseMarkdownBlocks(`Zażółć gęślą jaźń — Привет — Ελληνικά`)
		const pdf = await renderBlocksToPdf(blocks, fontBytes())
		const doc = await extractPdf(pdf)
		expect(doc.units[0].markdown).toContain("Zażółć")
		expect(doc.units[0].markdown).toContain("Привет")
	})

	it("rejects text the bundled fonts cannot encode (typed, never mojibake)", async () => {
		const blocks = parseMarkdownBlocks("中文 should fail cleanly")
		try {
			await renderBlocksToPdf(blocks, fontBytes())
			expect.unreachable()
		} catch (err) {
			expect(isDocumentError(err)).toBe(true)
			expect((err as { code: string }).code).toBe("unsupported-format")
			expect((err as Error).message).toContain("docx")
		}
	})

	it("rejects chart blocks with a typed pointing message", async () => {
		const blocks = parseMarkdownBlocks('```chart\n{"type":"bar"}\n```')
		await expect(renderBlocksToPdf(blocks, fontBytes())).rejects.toMatchObject({ code: "unsupported-format" })
	})

	it("embeds local PNG images", async () => {
		// 1x1 red PNG
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		)
		const blocks = parseMarkdownBlocks(`![dot](dot.png)\n\nafter image`)
		const pdf = await renderBlocksToPdf(blocks, fontBytes(), { loadImage: () => new Uint8Array(png) })
		const doc = await extractPdf(pdf)
		expect(doc.units[0].markdown).toContain("after image")
	})

	it("rejects remote images", async () => {
		const blocks = parseMarkdownBlocks(`![x](https://example.com/a.png)`)
		await expect(renderBlocksToPdf(blocks, fontBytes(), { loadImage: () => new Uint8Array() })).rejects.toMatchObject({
			code: "corrupt",
		})
	})

	it("rejects empty content", async () => {
		await expect(renderBlocksToPdf([], fontBytes())).rejects.toMatchObject({ code: "corrupt" })
	})

	it("letter page size changes the page box", async () => {
		const blocks = parseMarkdownBlocks("# hi")
		const pdf = await renderBlocksToPdf(blocks, fontBytes(), { pageSize: PAGE_SIZES.letter })
		const { PDFDocument } = await import("@cantoo/pdf-lib")
		const doc = await PDFDocument.load(pdf)
		expect(doc.getPage(0).getWidth()).toBeCloseTo(612, 0)
	})
})
