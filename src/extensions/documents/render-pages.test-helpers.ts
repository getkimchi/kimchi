/**
 * Test stubs for the pdfium loader seam in render-pages.ts. These stand in
 * for the real WASM library so tests can inject parse failures, per-page
 * render failures, and oversized page geometry without shipping hostile
 * PDF fixtures.
 */
import type { PdfiumLibraryInstance, PdfiumPageRender } from "./render-pages.js"
import { PAGE_RENDER_SCALE } from "./render-pages.js"

export interface FakePdfiumOptions {
	/** loadDocument throws with this message. */
	failParse?: string
	/** 1-based pages whose render() rejects. */
	failPages?: number[]
	/** 1-based page → point size override (default US Letter 612×792). */
	pageSizes?: Record<number, { originalWidth: number; originalHeight: number }>
}

/** Returns a pdfiumImport seam function backed by the stub described above. */
export function pdfiumImport(options: FakePdfiumOptions) {
	return async (): Promise<PdfiumLibraryInstance> => {
		const doc = {
			getPageCount: () => 2,
			getPage: (i: number) => {
				const page = i + 1
				const size = options.pageSizes?.[page] ?? { originalWidth: 612, originalHeight: 792 }
				return {
					getOriginalSize: () => size,
					render: async (): Promise<PdfiumPageRender> => {
						if (options.failPages?.includes(page)) throw new Error(`render failed on page ${page}`)
						const width = Math.floor(size.originalWidth * PAGE_RENDER_SCALE)
						const height = Math.floor(size.originalHeight * PAGE_RENDER_SCALE)
						return {
							width,
							height,
							originalWidth: size.originalWidth,
							originalHeight: size.originalHeight,
							data: new Uint8Array(width * height * 4),
						}
					},
				}
			},
			destroy: () => {},
		}
		// Stub vs the full PDFiumLibrary interface: a targeted double cast is the
		// honest way to hand the seam a partial — only loadDocument is exercised.
		return {
			loadDocument: async () => {
				if (options.failParse) throw new Error(options.failParse)
				return doc
			},
		} as unknown as PdfiumLibraryInstance
	}
}
