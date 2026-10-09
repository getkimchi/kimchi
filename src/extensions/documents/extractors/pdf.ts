/**
 * PDF extractor via unpdf (serverless PDF.js).
 *
 * Determinism: cMaps and standard fonts come from the bundled pdfjs assets
 * (never the host's fonts), and maxImageSize is capped at 16 MP per unpdf's
 * untrusted-PDF guidance. Page count is read from the proxy BEFORE text is
 * extracted so oversized documents short-circuit cleanly.
 */

import { extractText, getDocumentProxy } from "unpdf"
import { PDF_MAX_IMAGE_PIXELS } from "../limits.js"
import { DocumentError, type ExtractedDocument } from "../model.js"
import { resolvePdfjsAssets } from "../pdfjs-assets.js"

type PdfLikeDocumentProxy = Awaited<ReturnType<typeof getDocumentProxy>>

export const __testables = { translatePdfError }

function translatePdfError(err: unknown): DocumentError {
	const name = (err as { name?: string })?.name ?? ""
	const message = (err as Error)?.message ?? String(err)
	if (name === "PasswordException" || /password/i.test(name)) {
		return new DocumentError(
			"password-protected",
			"PDF is password-protected; password support is not implemented.",
			"pdf",
		)
	}
	if (name === "AbortException") {
		return new DocumentError("timeout", "PDF extraction timed out.", "pdf")
	}
	return new DocumentError("corrupt", `Not a readable PDF: ${message}`, "pdf")
}

export async function extractPdf(data: Uint8Array): Promise<ExtractedDocument> {
	const assets = resolvePdfjsAssets()
	let pdf: PdfLikeDocumentProxy
	try {
		pdf = await getDocumentProxy(data, {
			useSystemFonts: false,
			disableFontFace: true,
			maxImageSize: PDF_MAX_IMAGE_PIXELS,
			cMapUrl: assets.cMapUrl,
			cMapPacked: assets.cMapPacked,
			standardFontDataUrl: assets.standardFontDataUrl,
			verbosity: 0,
		})
	} catch (err) {
		throw translatePdfError(err)
	}
	try {
		const pageCount = pdf.numPages
		if (pageCount === 0) {
			throw new DocumentError("corrupt", "PDF has no pages.", "pdf")
		}
		let pages: string[]
		try {
			const result = await extractText(pdf, { mergePages: false })
			pages = result.text
		} catch (err) {
			throw translatePdfError(err)
		}

		const notes: string[] = []
		const units = pages.map((text, i) => {
			const clean = normalizePdfText(text)
			if (!clean.trim()) notes.push(`page ${i + 1} has no text layer`)
			return { index: i + 1, label: `Page ${i + 1}`, markdown: clean }
		})
		const outline = units.map((u) => {
			const first =
				u.markdown
					.split("\n")
					.find((l) => l.trim())
					?.trim() ?? "(no text)"
			return `Page ${u.index}: ${first.slice(0, 80)}`
		})
		return { format: "pdf", unitKind: "page", units, outline, notes }
	} finally {
		const destroyable = pdf as unknown as { destroy?: () => Promise<void> }
		await destroyable.destroy?.().catch(() => {})
	}
}

/** PDF.js emits one text item per line with platform line endings; normalize
 *  them and collapse >2 consecutive blank lines so output is stable across
 *  fonts and platforms. */
function normalizePdfText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
}
