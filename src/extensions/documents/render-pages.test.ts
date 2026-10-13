import { describe, expect, it } from "vitest"
import { extractDocument } from "./extract.js"
import { makeScannedPdf, makeSimplePdf } from "./fixtures/builders.js"
import {
	loadPdfium,
	maybeRenderScannedPages,
	noTextLayerPages,
	PAGE_RENDER_SCALE,
	renderPdfPages,
} from "./render-pages.js"

describe("render-pages (Phase 1.6)", () => {
	it("identifies pages with no text layer, only for pdf format", async () => {
		const scanned = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		expect(noTextLayerPages(scanned)).toEqual([1, 2])
		const textPdf = await extractDocument("text.pdf", await makeSimplePdf(), { tool: "read_document" })
		expect(noTextLayerPages(textPdf)).toEqual([])
		expect(noTextLayerPages({ format: "csv", units: [{ index: 1, markdown: "" }] })).toEqual([])
	})

	it("renders image-only pages to PNG", async () => {
		const { pdfium, error } = await loadPdfium()
		if (!pdfium) {
			// All 5 release targets ship the same WASM; reaching here means an
			// exotic environment — the degradation path is covered below.
			expect(error).toBeTruthy()
			return
		}
		const data = await makeScannedPdf()
		const { images, unavailableNote } = await renderPdfPages(data, [1, 2, 99])
		expect(unavailableNote).toBeUndefined()
		expect([...images.keys()].sort((a, b) => a - b)).toEqual([1, 2]) // out-of-range skipped
		for (const png of images.values()) {
			expect(png.length).toBeGreaterThan(100)
			expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		}
		expect(PAGE_RENDER_SCALE).toBeGreaterThanOrEqual(150 / 72)
	})

	it("degrades to a note (never throws) when pdfium fails to load", async () => {
		const failing = async () => {
			throw new Error("injected pdfium failure")
		}
		const { images, unavailableNote } = await renderPdfPages(await makeScannedPdf(), [1], {
			pdfiumImport: failing,
		})
		expect(images.size).toBe(0)
		expect(unavailableNote).toContain("injected pdfium failure")
	})

	it("degrades to a note when the document itself fails to parse (hostile bytes)", async () => {
		const { pdfiumImport } = await import("./render-pages.test-helpers.js")
		const { images, unavailableNote } = await renderPdfPages(await makeScannedPdf(), [1], {
			pdfiumImport: pdfiumImport({ failParse: "corrupt xref table" }),
		})
		expect(images.size).toBe(0)
		expect(unavailableNote).toContain("corrupt xref table")
	})

	it("skips a page whose render fails without sinking the other pages", async () => {
		const { pdfiumImport } = await import("./render-pages.test-helpers.js")
		const { images, unavailableNote } = await renderPdfPages(await makeScannedPdf(), [1, 2], {
			pdfiumImport: pdfiumImport({ failPages: [1] }),
		})
		expect(unavailableNote).toBeUndefined()
		expect([...images.keys()]).toEqual([2])
	})

	it("rejects oversized pages before rasterizing (no bitmap allocation)", async () => {
		const { pdfiumImport } = await import("./render-pages.test-helpers.js")
		const oversized = pdfiumImport({
			pageSizes: { 1: { originalWidth: 20000, originalHeight: 20000 } }, // 20000·2.083² ≫ 4096²
		})
		const { images, unavailableNote } = await renderPdfPages(await makeScannedPdf(), [1, 2], {
			pdfiumImport: oversized,
		})
		expect(unavailableNote).toBeUndefined()
		expect([...images.keys()]).toEqual([2]) // page 1 skipped pre-render, page 2 intact
	})
})

describe("maybeRenderScannedPages — vision gate", () => {
	it("attaches base64 PNG blocks when the model accepts images", async () => {
		const doc = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		const { pdfium } = await loadPdfium()
		if (!pdfium) return
		const result = await maybeRenderScannedPages({
			data: await makeScannedPdf(),
			doc,
			supportsImages: true,
			selected: [1],
		})
		expect(result.note).toBeUndefined()
		expect(result.images).toHaveLength(1) // selection narrows which pages render
		expect(result.images[0].page).toBe(1)
		expect(result.images[0].mimeType).toBe("image/png")
		expect(result.images[0].data.length).toBeGreaterThan(100)
	})

	it("returns nothing and keeps the warning path for text-only models", async () => {
		const doc = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		const result = await maybeRenderScannedPages({
			data: await makeScannedPdf(),
			doc,
			supportsImages: false,
		})
		expect(result.images).toEqual([])
		expect(result.note).toBeUndefined()
		expect(doc.notes.join(" ")).toContain("no text layer")
	})

	it("surfaces a note (never throws) when pdfium is mandatory but unavailable", async () => {
		const doc = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		const result = await maybeRenderScannedPages({
			data: await makeScannedPdf(),
			doc,
			supportsImages: true,
			pdfiumImport: async () => {
				throw new Error("injected")
			},
		})
		expect(result.images).toEqual([])
		expect(result.note).toContain("injected")
	})
})
