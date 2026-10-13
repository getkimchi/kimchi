/**
 * Document IR — the shared intermediate representation every extractor
 * produces and every consumer (read_document, read interception, @file,
 * doctor, accuracy suite) renders from.
 *
 * Locators used by later edit phases live here so the read output shape
 * never changes when editing arrives:
 *   PDF:  unit labels are `Page N`; form field names are secondary locators.
 *   PPTX: unit labels are `Slide N`; shapes are `[shape "Title 1"]`.
 *   XLSX: unit labels are sheet names; cells are `A1`-style refs.
 *   DOCX: a single `document` unit; tables are `[table N]`, text anchors
 *         follow pi `edit` uniqueness semantics.
 */

export type DocumentFormat = "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "ods" | "csv"

export type UnitKind = "page" | "slide" | "sheet" | "document"

export interface DocumentUnit {
	/** 1-based within the document (page/slide number, or sheet position). */
	index: number
	/** Human label rendered in the markdown view: "Page 1", "Slide 2", "Sheet: Totals". */
	label: string
	/** Sheet name for spreadsheets; slide/sheet title where one exists. */
	name?: string
	markdown: string
}

export interface ExtractedDocument {
	format: DocumentFormat
	unitKind: UnitKind
	units: DocumentUnit[]
	/** One-line-per-unit summary for the @file outline path. No content excerpts. */
	outline: string[]
	/** Degradation notes (no content): e.g. "page 3 has no text layer". */
	notes: string[]
	/** Structured form fields / other locator metadata for later phases. */
	meta?: Record<string, unknown>
}

export type DocumentErrorCode =
	| "not-a-document" // magic bytes match no supported format
	| "unsupported-format" // recognized but not readable in this phase (legacy .doc/.ppt)
	| "too-large" // over the 20 MB cap (or KIMCHI_DOCUMENT_MAX_MB)
	| "safety-limit" // zip-bomb / symlink / path-traversal / entry caps
	| "corrupt"
	| "password-protected"
	| "extraction-failed"
	| "timeout"

export class DocumentError extends Error {
	readonly code: DocumentErrorCode
	readonly format?: DocumentFormat
	constructor(code: DocumentErrorCode, message: string, format?: DocumentFormat) {
		super(message)
		this.name = "DocumentError"
		this.code = code
		this.format = format
	}
}

export function isDocumentError(err: unknown): err is DocumentError {
	return err instanceof DocumentError
}
