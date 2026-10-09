/**
 * Extraction orchestrator: size cap → magic-byte detection → per-format
 * extractor → character caps → typed errors → telemetry metadata.
 * All extractors receive the whole (capped) file; per-entry caps inside
 * zips live in ooxml/package.ts.
 */

import { basename } from "node:path"
import { detectDocumentFormat } from "./detect.js"
import { extractDocx } from "./extractors/docx.js"
import { extractPdf } from "./extractors/pdf.js"
import { extractPptx } from "./extractors/pptx.js"
import { extractXlsxLike, type XlsxExtractOptions } from "./extractors/xlsx.js"
import { EXTRACTION_TIMEOUT_MS, MAX_EXTRACTED_CHARS, MAX_FILE_MB_ENV, maxFileBytes } from "./limits.js"
import { DocumentError, type ExtractedDocument } from "./model.js"
import { emitDocumentEvent, sizeRangeOf } from "./telemetry.js"

export interface ExtractOptions extends XlsxExtractOptions {
	env?: NodeJS.ProcessEnv
	timeoutMs?: number
	/** Telemetry tool label — "read", "read_document", "at-file", "doctor". */
	tool?: "read" | "read_document" | "at-file" | "doctor"
}

export async function extractDocument(
	path: string,
	data: Uint8Array,
	options: ExtractOptions = {},
): Promise<ExtractedDocument> {
	const started = Date.now()
	const env = options.env ?? process.env
	const cap = maxFileBytes(env)
	if (data.length > cap) {
		const err = new DocumentError(
			"too-large",
			`${basename(path)} is ${(data.length / 1024 / 1024).toFixed(1)} MB, over the ${cap / 1024 / 1024} MB document cap. Raise it with ${MAX_FILE_MB_ENV}.`,
		)
		emitDocumentEvent({ tool: options.tool ?? "read", sizeRange: sizeRangeOf(data.length), errorType: err.code })
		throw err
	}

	const detection = await detectDocumentFormat(path, data)
	if (!detection) {
		throw new DocumentError("not-a-document", `${basename(path)} is not a recognized document format.`)
	}

	const timeoutMs = options.timeoutMs ?? EXTRACTION_TIMEOUT_MS
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new DocumentError("timeout", `Extraction exceeded ${timeoutMs}ms.`, detection.format))
		}, timeoutMs)
	})
	// The timeout losing the race must not hold the process open. The executor
	// above assigns the timer synchronously, but TS can't narrow the closure
	// capture — hence the optional chain on the variable itself.
	timer?.unref()

	try {
		const extract = async (): Promise<ExtractedDocument> => {
			switch (detection.format) {
				case "pdf":
					return extractPdf(data)
				case "docx":
					return extractDocx(data)
				case "pptx":
					return extractPptx(data)
				case "xlsx":
				case "xls":
				case "ods":
					return extractXlsxLike(data, detection.format, options)
				case "csv": {
					const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
					return extractXlsxLike(text, "csv", options)
				}
			}
		}
		let doc = await Promise.race([extract(), timeout])
		doc = capExtractedChars(doc, detection.format)
		emitDocumentEvent({
			tool: options.tool ?? "read",
			format: detection.format,
			sizeRange: sizeRangeOf(data.length),
			units: doc.units.length,
			durationMs: Date.now() - started,
		})
		return doc
	} catch (err) {
		const typed =
			err instanceof DocumentError
				? err
				: new DocumentError("extraction-failed", (err as Error).message, detection.format)
		emitDocumentEvent({
			tool: options.tool ?? "read",
			format: detection.format,
			sizeRange: sizeRangeOf(data.length),
			durationMs: Date.now() - started,
			errorType: typed.code,
		})
		throw typed
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function capExtractedChars(doc: ExtractedDocument, format: ExtractedDocument["format"]): ExtractedDocument {
	let total = 0
	const units = doc.units.map((u) => {
		const next = total + u.markdown.length
		if (next <= MAX_EXTRACTED_CHARS) {
			total = next
			return u
		}
		const remaining = MAX_EXTRACTED_CHARS - total
		total = MAX_EXTRACTED_CHARS
		return {
			...u,
			markdown: remaining > 0 ? u.markdown.slice(0, remaining) : "",
		}
	})
	const truncated = doc.units.some((u, i) => u.markdown.length !== units[i].markdown.length)
	if (truncated) {
		return { ...doc, units, notes: [...doc.notes, `extracted text truncated at ${MAX_EXTRACTED_CHARS} characters`] }
	}
	return { ...doc, units, format }
}
