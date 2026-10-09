import { describe, expect, it } from "vitest"
import { extractDocument } from "./extract.js"
import { makeScannedPdf, makeSimplePdf } from "./fixtures/builders.js"
import {
	loadCanvas,
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
		const { canvas, error } = await loadCanvas()
		if (!canvas) {
			// All 5 release targets ship prebuilt canvas; reaching here means an
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

	it("degrades to a note (never throws) when canvas fails to load", async () => {
		const failing = async (): Promise<typeof import("@napi-rs/canvas")> => {
			throw new Error("injected canvas failure")
		}
		const { images, unavailableNote } = await renderPdfPages(await makeScannedPdf(), [1], {
			canvasImport: failing,
		})
		expect(images.size).toBe(0)
		expect(unavailableNote).toContain("injected canvas failure")
	})
})

describe("maybeRenderScannedPages — vision gate", () => {
	it("attaches base64 PNG blocks when the model accepts images", async () => {
		const doc = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		const { canvas } = await loadCanvas()
		if (!canvas) return
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

	it("surfaces a note (never throws) when canvas is mandatory but unavailable", async () => {
		const doc = await extractDocument("scan.pdf", await makeScannedPdf(), { tool: "read_document" })
		const result = await maybeRenderScannedPages({
			data: await makeScannedPdf(),
			doc,
			supportsImages: true,
			canvasImport: async () => {
				throw new Error("injected")
			},
		})
		expect(result.images).toEqual([])
		expect(result.note).toContain("injected")
	})
})
