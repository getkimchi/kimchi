/**
 * PDF text extraction for the bundled pdf.mjs CLI. In-process via unpdf
 * (pdf.js). Per-page text becomes a `Page N` unit; per-page notes name
 * pages without a text layer; an all-empty document is a typed error the
 * skill translates into "scanned/image-only", never guessed content.
 *
 * Buffer ownership: pdf.js's loopback worker consumes its Uint8Array as a
 * transferable and detaches the ArrayBuffer, so we always hand it a copy
 * (`data.slice()`) — callers keep their bytes usable afterwards.
 *
 * pdf.js assets (cmaps, standard fonts): unpdf falls back to its own
 * vendored pdf.js build when pdfjs-dist can't resolve (bundled CLI,
 * compiled binary). Standard-font PDFs extract fine either way; pages
 * that need cmap/standard-font assets report the honest [no text layer]
 * note when nothing comes out.
 */

import { getDocumentProxy } from "unpdf"
import { DocumentError, type ExtractedDocument } from "../model.js"

/** A page "has a text layer" when ANY text comes out — short pages
 *  ("p1", "CEO") are legitimate; scanned pages yield nothing at all. */
const MIN_PAGE_TEXT_CHARS = 1

function isPasswordError(err: unknown): boolean {
	const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
	return /password/i.test(msg)
}

/**
 * Extract text pages. `pages` is a 1-based page filter (already clamped by
 * the caller) — undefined extracts all pages (still capped at
 * MAX_UNITS_PER_CALL of them inside one CLI call).
 */
// unpdf's lifecycle hook: the proxy's own close path is loadingTask.destroy().
type Destroyable = Awaited<ReturnType<typeof getDocumentProxy>> & {
	loadingTask: { destroy(): Promise<void> }
}

/**
 * MAX_UNITS_PER_CALL of them inside one CLI call).
 */
export async function extractPdf(data: Uint8Array, options: { pages?: number[] } = {}): Promise<ExtractedDocument> {
	if (!data.subarray(0, 5).every((b, i) => b === "%PDF-".charCodeAt(i))) {
		throw new DocumentError("not-a-document", "not a PDF (missing %PDF- header)", "pdf")
	}
	let pdf: Destroyable
	try {
		pdf = (await getDocumentProxy(data.slice())) as Destroyable
	} catch (err) {
		if (isPasswordError(err)) {
			throw new DocumentError("password-protected", "PDF is password-protected; ask for a decrypted copy", "pdf")
		}
		throw new DocumentError("corrupt", `PDF failed to parse: ${(err as Error).message ?? err}`, "pdf")
	}

	try {
		const total = pdf.numPages
		const wanted = options.pages && options.pages.length > 0 ? options.pages : range(total)
		const units = []
		const notes: string[] = []
		let anyText = false
		for (const n of wanted) {
			if (n < 1 || n > total) continue
			let markdown: string
			try {
				const page = await pdf.getPage(n)
				const content = await page.getTextContent()
				const parts: string[] = []
				for (const item of content.items) {
					if (typeof item !== "object" || item === null || !("str" in item)) continue
					const it = item as { str?: unknown; hasEOL?: unknown }
					parts.push(typeof it.str === "string" ? it.str : "")
					if (it.hasEOL === true) parts.push("\n")
				}
				markdown = parts
					.join("")
					.replace(/[ \t]+\n/g, "\n")
					.replace(/\n{3,}/g, "\n\n")
					.trim()
			} catch {
				// Fail-soft per page — a damaged page must not sink the whole read.
				notes.push(`page ${n} failed to parse — skipped`)
				continue
			}
			if (markdown.length >= MIN_PAGE_TEXT_CHARS) {
				anyText = true
			} else {
				notes.push(`page ${n} has no text layer`)
			}
			units.push({
				index: n,
				label: `Page ${n}`,
				markdown,
			})
		}
		if (!anyText) {
			throw new DocumentError(
				"extraction-failed",
				`no text layer on ${wanted.length > 1 ? "any of " : ""}${wanted.length === 1 ? `page ${wanted[0]}` : `${wanted.length} pages`} — likely a scanned/image-only PDF. Describe the limitation instead of guessing content.`,
				"pdf",
			)
		}
		return {
			format: "pdf",
			unitKind: "page",
			units,
			outline: units.map((u) => `${u.label}: ${u.markdown.split("\n")[0]?.slice(0, 80) ?? ""}`),
			notes,
			meta: { pageCount: total },
		}
	} finally {
		// destroy() itself must not become an unhandled rejection, and the
		// CLI's exit must not outrun cleanup.
		await pdf.loadingTask.destroy().catch(() => {})
	}
}

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i + 1)
}

/** `pdf.mjs info` payload: structure facts without content. */
export async function pdfInfo(data: Uint8Array): Promise<{ pageCount: number; encrypted: boolean }> {
	if (!data.subarray(0, 5).every((b, i) => b === "%PDF-".charCodeAt(i))) {
		throw new DocumentError("not-a-document", "not a PDF (missing %PDF- header)", "pdf")
	}
	try {
		const pdf = (await getDocumentProxy(data.slice())) as Destroyable
		try {
			return { pageCount: pdf.numPages, encrypted: false }
		} finally {
			pdf.loadingTask.destroy()
		}
	} catch (err) {
		if (isPasswordError(err)) {
			return { pageCount: 0, encrypted: true }
		}
		throw new DocumentError("corrupt", `PDF failed to parse: ${(err as Error).message ?? err}`, "pdf")
	}
}
