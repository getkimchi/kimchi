import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"
import { describe, expect, it } from "vitest"
import { encodePngRgba, renderPdfCore } from "./pdf-png.js"

async function makePdf(pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of pages) {
		const page = doc.addPage([200, 150])
		page.drawText(text, { x: 20, y: 75, size: 18, font })
	}
	return new Uint8Array(await doc.save())
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pdf-png-test-"))
	return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe("encodePngRgba", () => {
	it("writes a valid PNG: signature, IHDR dimensions, deflatable IDAT", () => {
		// 2×1, one red and one blue pixel.
		const px = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255])
		const png = encodePngRgba(px, 2, 1)
		expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		// IHDR: width=2, height=1, 8-bit RGBA.
		expect(Array.from(png.subarray(16, 24))).toEqual([0, 0, 0, 2, 0, 0, 0, 1])
		expect(Array.from(png.subarray(24, 29))).toEqual([8, 6, 0, 0, 0])
		// IDAT chunk inflates back to the two filter-0 scanlines of one row.
		const idatType = String.fromCharCode(...png.subarray(37, 41))
		expect(idatType).toBe("IDAT")
		const idatLen = (png[33] << 24) | (png[34] << 16) | (png[35] << 8) | png[36]
		const raw = inflateSync(png.subarray(41, 41 + idatLen))
		expect(raw[0]).toBe(0) // filter byte
		expect(Array.from(raw.subarray(1, 5))).toEqual([255, 0, 0, 255])
		expect(Array.from(raw.subarray(5, 9))).toEqual([0, 0, 255, 255])
	})

	it("encodes multi-megabyte images without the old call-stack blowup", () => {
		// A4 at 110dpi ≈ 909 × 1284 × 4 bytes — the size that first hit
		// "Maximum call stack size exceeded" through the spread-based writeChunk.
		const w = 909
		const h = 1284
		const px = new Uint8Array(w * h * 4).fill(255)
		px.forEach((_, i) => {
			if (i % 4 === 0 && i % 997 < 4) px[i] = 100
		})
		const png = encodePngRgba(px, w, h)
		expect(png.length).toBeGreaterThan(1000)
		expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	})
})

describe("renderPdfCore (real PDFium)", () => {
	it("renders every page with real text visible (not blank)", () =>
		withTempDir(async (dir) => {
			const pdfPath = join(dir, "doc.pdf")
			writeFileSync(pdfPath, await makePdf(["hello", "world"]))
			const { images, pageCount } = await renderPdfCore(pdfPath, dir, undefined)
			expect(pageCount).toBe(2)
			expect(images).toHaveLength(2)
			expect(images[0]).toMatch(/doc-1\.png$/)
			for (const img of images) {
				const png = readFileSync(img)
				// PNG signature
				expect(Array.from(png.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])
				// Not blank: IDAT must inflate to scanlines with at least one non-white pixel.
				expect(blankScore(png)).toBeGreaterThan(0)
			}
		}))

	it("--pages selection yields only the selected pages", () =>
		withTempDir(async (dir) => {
			const pdfPath = join(dir, "doc.pdf")
			writeFileSync(pdfPath, await makePdf(["a", "b", "c"]))
			const { images } = await renderPdfCore(pdfPath, dir, { start: 2, end: 2 })
			expect(images).toHaveLength(1)
			expect(images[0]).toMatch(/doc-2\.png$/)
		}))

	it("rejects an out-of-range page selection", () =>
		withTempDir(async (dir) => {
			const pdfPath = join(dir, "doc.pdf")
			writeFileSync(pdfPath, await makePdf(["a"]))
			await expect(renderPdfCore(pdfPath, dir, { start: 5, end: 9 })).rejects.toMatchObject({
				code: "corrupt",
			})
		}))

	it("sweeps stale same-stem PNGs", () =>
		withTempDir(async (dir) => {
			const pdfPath = join(dir, "doc.pdf")
			writeFileSync(pdfPath, await makePdf(["a"]))
			writeFileSync(join(dir, "doc-7.png"), new TextEncoder().encode("stale"))
			writeFileSync(join(dir, "other-7.png"), new TextEncoder().encode("keep"))
			const { images } = await renderPdfCore(pdfPath, dir, undefined)
			expect(images).toHaveLength(1)
			expect(() => readFileSync(join(dir, "doc-7.png"))).toThrow()
			expect(() => readFileSync(join(dir, "other-7.png"))).not.toThrow()
		}))
})

/** 0 = blank (all-white), >0 = some ink. Walks all IDAT chunks, inflated. */
function blankScore(png: Uint8Array): number {
	let off = 8
	while (off + 8 <= png.length) {
		const len = (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) | png[off + 3]
		const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
		if (type === "IDAT") {
			const raw = inflateSync(png.subarray(off + 8, off + 8 + len))
			for (const b of raw) if (b < 200) return 1
		}
		off += 12 + len
	}
	return 0
}
