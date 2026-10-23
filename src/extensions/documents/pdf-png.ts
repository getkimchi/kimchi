/**
 * Core page rendering: PDF page → PNG in-process via PDFium (WASM), so the
 * visual check works on any fresh install — no pdftoppm, gs or pymupdf.
 * The wasm binary ships next to pdf.mjs (same staging pattern as
 * lodraw_edit.py) and is passed to the library as bytes, so nothing ever
 * goes looking under node_modules paths that don't exist in the bundle.
 *
 * Raw RGBA bitmaps are encoded to PNG here with Node's zlib — no image
 * dependency (sharp would be a native addon).
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { crc32, deflateSync } from "node:zlib"
import { PDFiumLibrary } from "@hyzyla/pdfium"
import { DocumentError } from "./model.js"

/** ~110 DPI — matches the external rasterizer chain. */
const RENDER_SCALE = 110 / 72

export interface PdfiumDocLike {
	pages: () => IterableIterator<PdfiumPageLike>
	destroy: () => void
}

interface PdfiumPageLike {
	render: (options: {
		scale: number
		render: (opts: { data: Uint8Array; width: number; height: number }) => Promise<Uint8Array>
	}) => Promise<{ data: Uint8Array }>
}

interface PdfiumLibraryLike {
	loadDocument: (data: Uint8Array, password?: string) => Promise<PdfiumDocLike>
	destroy: () => void
}

export interface PdfPngDeps {
	/** Load the 5.3 MB wasm module; default resolves the file next to the CLI. */
	loadWasm?: () => Promise<Uint8Array>
	/** Library constructor seam for tests. */
	initLibrary?: (wasm: Uint8Array) => Promise<PdfiumLibraryLike>
}

function defaultLoadWasm(): Promise<Uint8Array> {
	const moduleDir = dirname(fileURLToPath(import.meta.url))
	for (const dir of [
		moduleDir,
		resolve(moduleDir, "../../../resources/skills/pdf/scripts"),
		resolve(process.cwd(), "resources/skills/pdf/scripts"),
	]) {
		const candidate = join(dir, "pdfium.wasm")
		try {
			return Promise.resolve(new Uint8Array(readFileSync(candidate)))
		} catch {
			// next candidate
		}
	}
	throw new DocumentError(
		"tool-missing",
		"pdfium.wasm not found next to the pdf CLI or in the skill resources (this is a packaging bug — it ships with the skill). render falls back to external rasterizers when they exist.",
		"pdf",
	)
}

export interface RenderCoreResult {
	/** PNG paths in page order. */
	images: string[]
	pageCount: number
}

/**
 * Render the selected (1-based, inclusive) pages of `pdfPath` as PNGs into
 * `outDir`, named `<stem>-<page>.png` to match the external rasterizer
 * chain. `pages === undefined` renders all. Stale same-stem PNGs are swept
 * first so an earlier run's output can't pose as this run's.
 */
export async function renderPdfCore(
	pdfPath: string,
	outDir: string,
	pages: { start: number; end: number } | undefined,
	deps: PdfPngDeps = {},
): Promise<RenderCoreResult> {
	const wasm = await (deps.loadWasm ?? defaultLoadWasm)()
	const library = await (deps.initLibrary ?? (async (w) => PDFiumLibrary.init({ wasmBinary: w })))(wasm)
	const stem = pdfPath
		.replace(/\.pdf$/i, "")
		.split(/[/\\]/)
		.pop()!
	mkdirSync(outDir, { recursive: true })
	const stale = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.png$`)
	for (const entry of readdirSync(outDir)) {
		if (stale.test(entry)) {
			try {
				unlinkSync(join(outDir, entry))
			} catch {
				// best-effort — a locked file just leaves a stale PNG
			}
		}
	}
	try {
		const doc = await library.loadDocument(new Uint8Array(readFileSync(pdfPath)))
		try {
			const images: string[] = []
			let total = 0
			for (const page of doc.pages()) {
				const n = ++total
				if (pages && (n < pages.start || n > pages.end)) continue
				const image = await page.render({
					scale: RENDER_SCALE,
					render: async ({ data, width, height }) => encodePngRgba(data, width, height),
				})
				const dest = join(outDir, `${stem}-${n}.png`)
				writeFileSync(dest, image.data)
				images.push(dest)
			}
			if (pages && images.length === 0) {
				throw new DocumentError(
					"corrupt",
					`--pages ${pages.start}-${pages.end} selected none of the ${total} page(s) of ${pdfPath}.`,
					"pdf",
				)
			}
			return { images, pageCount: total }
		} finally {
			doc.destroy()
		}
	} finally {
		library.destroy()
	}
}

/** RGBA → PNG: filter-0 scanlines, deflate, standard IHDR/IDAT/IEND chunks. */
export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
	const stride = width * 4
	// Buffers, never array spreads: real pages carry MBs of image data and
	// `out.push(...data)` blows the call stack (hit live on an A4 render).
	const raw = Buffer.alloc((stride + 1) * height)
	for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
	const idat = deflateSync(raw, { level: 6 })

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // RGBA; compression/filter/interlace stay 0

	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	return Buffer.concat([
		signature,
		writeChunk("IHDR", ihdr),
		writeChunk("IDAT", idat),
		writeChunk("IEND", Buffer.alloc(0)),
	])
}

function writeChunk(type: string, data: Buffer): Buffer {
	const header = Buffer.alloc(8)
	header.writeUInt32BE(data.length, 0)
	header.write(type, 4, "ascii")
	const footer = Buffer.alloc(4)
	footer.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0, 0)
	return Buffer.concat([header, data, footer])
}
