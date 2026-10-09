/**
 * Format detection by magic bytes first, extension second.
 *
 * Renamed extensions must not change behavior: a .pdf named .txt is still a
 * PDF; a .zip renamed .docx is sniffed by its package entries. OOXML/ODS
 * share the zip container, so PK files are discriminated by well-known part
 * names from the zip listing ([Content_Types].xml plus word/xl/ppt roots).
 * Listing entry names does not inflate anything — that happens in the
 * extractor under ooxml/package.ts's caps.
 */

import { DocumentError, type DocumentFormat } from "./model.js"
import { listZipEntries } from "./ooxml/package.js"

export interface Detection {
	format: DocumentFormat
	/** What decided it — surfaced in doctor output for binary/dev parity checks. */
	reason: "magic" | "zip-parts" | "ole2-signature" | "ole2-extension" | "extension-text"
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
const ZIP_MAGICS: ReadonlyArray<readonly number[]> = [
	[0x50, 0x4b, 0x03, 0x04], // PK\x03\x04
	[0x50, 0x4b, 0x05, 0x06], // empty archive
	[0x50, 0x4b, 0x07, 0x08], // spanned
]
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function hasMagic(data: Uint8Array, magic: readonly number[]): boolean {
	if (data.length < magic.length) return false
	for (let i = 0; i < magic.length; i++) {
		if (data[i] !== magic[i]) return false
	}
	return true
}

function ext(path: string): string {
	const base = path.split(/[\\/]/).pop() ?? ""
	const dot = base.lastIndexOf(".")
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** True if every byte (sampled) is plausibly UTF-8/ASCII text (CSV sniffing). */
function looksLikeText(data: Uint8Array): boolean {
	const sample = data.subarray(0, Math.min(data.length, 4096))
	for (const byte of sample) {
		if (byte === 0x00) return false
		// Common control chars except \t \r \n \f
		if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) return false
	}
	return true
}

/**
 * Detect the document format of `data` (already size-capped by the caller).
 * Returns undefined when no supported format matches — callers treat that as
 * "not a document" and fall back to plain-text handling.
 */
export async function detectDocumentFormat(path: string, data: Uint8Array): Promise<Detection | undefined> {
	if (data.length === 0) return undefined

	if (hasMagic(data, PDF_MAGIC)) return { format: "pdf", reason: "magic" }

	if (hasMagic(data, OLE2_MAGIC)) {
		const extension = ext(path)
		if (extension === "xls") return { format: "xls", reason: "ole2-signature" }
		if (extension === "doc" || extension === "ppt") {
			throw new DocumentError(
				"unsupported-format",
				`Legacy binary .${extension} files are not readable yet (Phase 5: converted via LibreOffice).`,
			)
		}
		throw new DocumentError("unsupported-format", "OLE2 (legacy Office) file with unrecognized extension.")
	}

	if (ZIP_MAGICS.some((m) => hasMagic(data, m))) {
		let names: string[]
		try {
			names = await listZipEntries(data)
		} catch (err) {
			if (err instanceof DocumentError) throw err
			return undefined
		}
		const lower = new Set(names.map((n) => n.toLowerCase()))
		if (lower.has("word/document.xml")) return { format: "docx", reason: "zip-parts" }
		if (lower.has("xl/workbook.xml")) return { format: "xlsx", reason: "zip-parts" }
		if (lower.has("ppt/presentation.xml")) return { format: "pptx", reason: "zip-parts" }
		if (lower.has("content.xml") && lower.has("meta-inf/manifest.xml")) return { format: "ods", reason: "zip-parts" }
		// A zip with no document parts is not a document for our purposes.
		return undefined
	}

	const extension = ext(path)
	if ((extension === "csv" || extension === "tsv") && looksLikeText(data)) {
		return { format: "csv", reason: "extension-text" }
	}
	return undefined
}

/** Fast path used by read interception and @file before loading the file:
 *  the file extension suggests a document we *might* handle; magic bytes
 *  decide once the file is loaded. */
export function isDocumentPath(path: string): boolean {
	return ["pdf", "docx", "pptx", "xlsx", "xls", "xlsm", "docm", "pptm", "ods", "csv", "tsv", "doc", "ppt"].includes(
		ext(path),
	)
}
