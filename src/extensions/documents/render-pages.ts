/**
 * Page-image rendering for image-only PDF pages (Phase 1.6).
 *
 * Any PDF page with zero extracted characters is rendered to PNG and
 * attached as an image block when the session model accepts image input —
 * scanned receipts and photo-PDFs become readable without an OCR engine.
 * Vision models do the reading; we just ship the pixels.
 *
 * Degradation is a first-class behavior, both by plan and by test:
 *   - `@napi-rs/canvas` (native) fails to load → no images, existing
 *     "no text layer" warning stands. Same for text-only models: the vision
 *     gate is checked by the callers, wrong-model delivery never happens.
 *
 * The canvas import is lazy and literal (`import("@napi-rs/canvas")`):
 * canvas's js-binding.js resolves its platform .node file through
 * literal per-branch requires that Bun's bundler can follow per target
 * (the clipboard template-string lesson does not apply here).
 */

import { getDocumentProxy, renderPageAsImage } from "unpdf"
import type { ExtractedDocument } from "./model.js"
import { resolvePdfjsAssets } from "./pdfjs-assets.js"

/** 150 DPI ≈ scale 2.0833 at PDF.js's 72-DPI viewport — readable receipts,
 *  bounded pixels (Letter → 1275×1650 before PNG encoding). */
export const PAGE_RENDER_SCALE = 150 / 72

type CanvasModule = typeof import("@napi-rs/canvas")

export interface CanvasLoad {
	canvas: CanvasModule | null
	/** Human-readable reason when canvas is null (doctor/telemetry detail — no content). */
	error: string | null
}

let cachedCanvas: CanvasLoad | undefined

const defaultCanvasImport = async (): Promise<CanvasModule> => import("@napi-rs/canvas")

/** Load @napi-rs/canvas once per process; failure is cached and non-fatal. */
export async function loadCanvas(canvasImport: () => Promise<CanvasModule> = defaultCanvasImport): Promise<CanvasLoad> {
	if (cachedCanvas) return cachedCanvas
	try {
		const canvas = await canvasImport()
		cachedCanvas = { canvas, error: null }
	} catch (err) {
		cachedCanvas = { canvas: null, error: err instanceof Error ? err.message : String(err) }
	}
	return cachedCanvas
}

/** Test seam: reset the loader cache (used with canvasImport injection). */
export function __resetCanvasCacheForTests(): void {
	cachedCanvas = undefined
}

export interface PageRenderResult {
	/** Map from 1-based page number to PNG bytes. */
	images: Map<number, Uint8Array>
	/** Set when rendering was impossible at all (canvas failed to load). */
	unavailableNote?: string
}

/**
 * Render the given 1-based pages of a PDF to PNG. Pages outside numPages are
 * skipped (callers pass pages they already extracted, so this is defensive).
 * A canvas load failure returns an empty map plus a note — never throws.
 */
export async function renderPdfPages(
	data: Uint8Array,
	pages: readonly number[],
	options: { canvasImport?: () => Promise<CanvasModule> } = {},
): Promise<PageRenderResult> {
	const { canvas, error } = options.canvasImport ? await maybeLoadInjected(options.canvasImport) : await loadCanvas()
	if (!canvas) {
		return {
			images: new Map(),
			unavailableNote: `page images unavailable (canvas: ${error ?? "load failed"})`,
		}
	}
	const assets = resolvePdfjsAssets()
	// Defensive copy: pdf.js destroy() detaches the underlying ArrayBuffer
	// (transferable into its loopback port). Extractors destroy their proxy,
	// so re-opening the same bytes later would clone a detached buffer and
	// die with DataCloneError (observed under Bun's structuredClone and
	// intermittently in Node/vitest)
	const pdf = await getDocumentProxy(data.slice(), {
		useSystemFonts: false,
		disableFontFace: true,
		maxImageSize: 16_777_216,
		cMapUrl: assets.cMapUrl,
		cMapPacked: assets.cMapPacked,
		standardFontDataUrl: assets.standardFontDataUrl,
		verbosity: 0,
	})
	try {
		const images = new Map<number, Uint8Array>()
		// unpdf's createIsomorphicCanvasFactory consumes the loaded module —
		// passing the same import keeps a single module instance alive and lets
		// tests inject the failing-loader path end to end.
		const canvasImport = options.canvasImport ?? (async () => canvas)
		for (const page of pages) {
			if (page < 1 || page > pdf.numPages) continue
			const png = await renderPageAsImage(pdf, page, { scale: PAGE_RENDER_SCALE, canvasImport })
			images.set(page, new Uint8Array(png))
		}
		return { images }
	} finally {
		const destroyable = pdf as unknown as { destroy?: () => Promise<void> }
		await destroyable.destroy?.().catch(() => {})
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
async function maybeLoadInjected(canvasImport: () => Promise<CanvasModule>): Promise<CanvasLoad> {
	try {
		return { canvas: await canvasImport(), error: null }
	} catch (err) {
		return { canvas: null, error: err instanceof Error ? err.message : String(err) }
	}
}

export interface ScannedPagesOutcome {
	images: ScannedPageImage[]
	/** One-line note for the text body when images couldn't be produced
	 *  (e.g. canvas failed to load). Undefined when nothing went wrong. */
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
	doc: ExtractedDocument
	selected?: number[]
	supportsImages: boolean
	/** Test seam: inject a failing/strict canvas loader. */
	canvasImport?: () => Promise<CanvasModule>
}): Promise<ScannedPagesOutcome> {
	const pages = noTextLayerPages(args.doc)
	if (!args.supportsImages || pages.length === 0) return { images: [] }
	const wanted = args.selected ? pages.filter((p) => args.selected?.includes(p)) : pages
	if (wanted.length === 0) return { images: [] }
	const { images, unavailableNote } = await renderPdfPages(args.data, wanted, { canvasImport: args.canvasImport })
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
