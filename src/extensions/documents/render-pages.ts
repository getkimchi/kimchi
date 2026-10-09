/**
 * Page-image rendering for image-only PDF pages (Phase 1.6).
 *
 * Any PDF page with zero extracted characters is rendered to PNG and
 * attached as an image block when the session model accepts image input —
 * scanned receipts and photo-PDFs become readable without an OCR engine.
 * Vision models do the reading; we just ship the pixels.
 *
 * Rendering engine: @hyzyla/pdfium — Google PDFium (Chromium's engine)
 * compiled to a ~4 MB WASM sandbox. Chosen over a native canvas binding:
 * the sandbox keeps hostile-document parser bugs off our process memory,
 * one artifact covers every OS/arch we ship, and the bytes are ~22 MB
 * lighter than embedding skia. PNG encoding happens in pure JS
 * (png-encode.ts) — PDFium hands out raw BGRA bitmaps.
 *
 * Degradation is a first-class behavior, both by plan and by test:
 *   - the pdfium WASM fails to load → no images, the existing "no text
 *     layer" warning stands. Same for text-only models: the vision gate is
 *     checked by the callers, wrong-model delivery never happens.
 *
 * The module lazy-imports @hyzyla/pdfium on first use and caches the
 * outcome; callers can inject a loader for tests without the cache.
 */

import { readPdfiumWasm } from "./pdfium-wasm.js"
import { encodePngFromBgra } from "./png-encode.js"

/** 150 DPI ≈ scale 2.0833 at PDF's 72-DPI page units — readable receipts,
 *  bounded pixels (Letter → 1275×1650 before PNG encoding). */
export const PAGE_RENDER_SCALE = 150 / 72

/** We render pages but the largest image surface PDFium will rasterize for
 *  us is capped as a resource guard (matches pdf.js's default;-slightly
 *  smaller than unpdf's maxImageSize, at 150 DPI ≈ A0-ish page). */
const MAX_IMAGE_PIXELS = 4096 * 4096

export type PdfiumModule = typeof import("@hyzyla/pdfium")
export type PdfiumLibraryInstance = Awaited<ReturnType<PdfiumModule["PDFiumLibrary"]["init"]>>
export type PdfiumDocumentInstance = Awaited<ReturnType<PdfiumLibraryInstance["loadDocument"]>>
export type PdfiumPageRender = Awaited<ReturnType<ReturnType<PdfiumDocumentInstance["getPage"]>["render"]>>

export interface PdfiumLoad {
	pdfium: PdfiumLibraryInstance | null
	/** Human-readable reason when pdfium is null (doctor/telemetry detail — no content). */
	error: string | null
}

let cachedPdfium: PdfiumLoad | undefined

/** Optional wasm-binary override for the bundled-binary path: when the build
 *  stages pdfium.wasm itself, pass its bytes via wasmBinaryProvider so we do
 *  not depend on the node_modules layout surviving compilation. */
let wasmBinaryProvider: (() => Promise<Uint8Array> | Uint8Array) | undefined

/** Test seam: point the loader at alternate WASM bytes (unused in dev). */
export function __setPdfiumWasmProviderForTests(provider: typeof wasmBinaryProvider): void {
	wasmBinaryProvider = provider
	cachedPdfium = undefined
}

const defaultPdfiumImport = async (wasmBinary?: Uint8Array): Promise<PdfiumLibraryInstance> => {
	// We read the wasm ourselves and hand the bytes over: packaged binaries
	// resolve it via share/kimchi/pdfium/ (see pdfium-wasm.ts) — the library's
	// own locateFile path does not survive bun's bundling (no node_modules).
	const bytes = wasmBinary ?? (await readPdfiumWasm())
	const mod = (await import("@hyzyla/pdfium")) as PdfiumModule
	return mod.PDFiumLibrary.init({ wasmBinary: toArrayBuffer(bytes) })
}

/** The emscripten loader wants a raw ArrayBuffer — slicing guarantees one
 *  (and defensibly copies when handed a view into a larger buffer). */
function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
	if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer as ArrayBuffer
	return u8.slice().buffer
}

/** Load @hyzyla/pdfium once per process; failure is cached and non-fatal. */
export async function loadPdfium(
	pdfiumImport: (wasmBinary?: Uint8Array) => Promise<PdfiumLibraryInstance> = defaultPdfiumImport,
): Promise<PdfiumLoad> {
	if (cachedPdfium) return cachedPdfium
	try {
		const wasmBinary = wasmBinaryProvider ? await wasmBinaryProvider() : undefined
		const pdfium = await pdfiumImport(wasmBinary)
		cachedPdfium = { pdfium, error: null }
	} catch (err) {
		cachedPdfium = { pdfium: null, error: err instanceof Error ? err.message : String(err) }
	}
	return cachedPdfium
}

/** Test seam: reset the loader cache (used with pdfiumImport injection). */
export function __resetPdfiumCacheForTests(): void {
	cachedPdfium = undefined
}

export interface PageRenderResult {
	/** Map from 1-based page number to PNG bytes. */
	images: Map<number, Uint8Array>
	/** Set when rendering was impossible at all (pdfium failed to load). */
	unavailableNote?: string
}

/**
 * Render the given 1-based pages of a PDF to PNG. Pages outside numPages are
 * skipped (callers pass pages they already extracted, so this is defensive).
 * Never throws: a pdfium load/parse failure returns an empty map plus a note,
 * and a page whose render fails (hostile content, oversized page) is skipped
 * individually without sinking the rest.
 */
export async function renderPdfPages(
	data: Uint8Array,
	pages: readonly number[],
	options: { pdfiumImport?: (wasmBinary?: Uint8Array) => Promise<PdfiumLibraryInstance> } = {},
): Promise<PageRenderResult> {
	const { pdfium, error } = options.pdfiumImport ? await maybeLoadInjected(options.pdfiumImport) : await loadPdfium()
	if (!pdfium) {
		return {
			images: new Map(),
			unavailableNote: `page images unavailable (pdfium: ${error ?? "load failed"})`,
		}
	}
	let doc: PdfiumDocumentInstance
	try {
		doc = await pdfium.loadDocument(data)
	} catch (err) {
		return {
			images: new Map(),
			unavailableNote: `page images unavailable (pdfium: ${err instanceof Error ? err.message : String(err)})`,
		}
	}
	try {
		const images = new Map<number, Uint8Array>()
		for (const page of pages) {
			if (page < 1 || page > doc.getPageCount()) continue
			try {
				// Pre-raster check: PDFium allocates the full bitmap during render,
				// so an oversized page must be rejected from its point size BEFORE
				// rendering, not from the rendered bitmap afterwards.
				const { originalWidth, originalHeight } = doc.getPage(page - 1).getOriginalSize()
				if (originalWidth * PAGE_RENDER_SCALE * (originalHeight * PAGE_RENDER_SCALE) > MAX_IMAGE_PIXELS) continue
				const rendered = await doc.getPage(page - 1).render({ scale: PAGE_RENDER_SCALE })
				if (rendered.width * rendered.height > MAX_IMAGE_PIXELS) continue
				images.set(page, encodePngFromBgra(rendered.width, rendered.height, rendered.data))
			} catch {}
		}
		return { images }
	} finally {
		try {
			doc.destroy()
		} catch {
			// best-effort: wasm heap cleanup
		}
	}
}

/**
 * Indices of pages with zero extracted text — the only ones worth rendering.
 * Derived from unit contents (not a serialized flag on units) so partially
 * selected documents degrade to rendering nothing rather than rendering wrong.
 */
export function noTextLayerPages(doc: {
	format: string
	units: ReadonlyArray<{ index: number; markdown: string }>
}): number[] {
	if (doc.format !== "pdf") return []
	return doc.units.filter((u) => !u.markdown.trim()).map((u) => u.index)
}

export interface ScannedPageImage {
	page: number
	/** base64 PNG */
	data: string
	mimeType: "image/png"
}

/** Failure injection path for tests: never touches the production cache. */
async function maybeLoadInjected(
	pdfiumImport: (wasmBinary?: Uint8Array) => Promise<PdfiumLibraryInstance>,
): Promise<PdfiumLoad> {
	try {
		return { pdfium: await pdfiumImport(), error: null }
	} catch (err) {
		return { pdfium: null, error: err instanceof Error ? err.message : String(err) }
	}
}

export interface ScannedPagesOutcome {
	images: ScannedPageImage[]
	/** One-line note for the text body when images couldn't be produced
	 *  (e.g. pdfium failed to load). Undefined when nothing went wrong. */
	note?: string
}

/**
 * Shared Phase-1.6 glue for `read_document` and the `read` interception:
 * render every image-only page in the CURRENT selection to base64 PNG blocks
 * when the model accepts images. Never throws — failure modes return `note`
 * for the caller to append to the text body.
 *
 * @param selected 1-based unit indices the caller is actually returning
 */
export async function maybeRenderScannedPages(args: {
	data: Uint8Array
	doc: ExtractedDocumentPublic
	selected?: number[]
	supportsImages: boolean
	/** Test seam: inject a failing/strict pdfium loader. */
	pdfiumImport?: (wasmBinary?: Uint8Array) => Promise<PdfiumLibraryInstance>
}): Promise<ScannedPagesOutcome> {
	const pages = noTextLayerPages(args.doc)
	if (!args.supportsImages || pages.length === 0) return { images: [] }
	const wanted = args.selected ? pages.filter((p) => args.selected?.includes(p)) : pages
	if (wanted.length === 0) return { images: [] }
	const { images, unavailableNote } = await renderPdfPages(args.data, wanted, { pdfiumImport: args.pdfiumImport })
	if (images.size === 0) {
		return { images: [], note: unavailableNote ?? "page images unavailable" }
	}
	const blocks: ScannedPageImage[] = [...images.entries()].map(([page, png]) => ({
		page,
		data: Buffer.from(png).toString("base64"),
		mimeType: "image/png",
	}))
	const note = unavailableNote
	return { images: blocks, note }
}

/** Structural subset of ExtractedDocument this file needs — keeps the import
 *  surface small for the binary-build assembly in tests. */
type ExtractedDocumentPublic = {
	format: string
	units: ReadonlyArray<{ index: number; markdown: string }>
}
