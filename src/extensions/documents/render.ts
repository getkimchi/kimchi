/**
 * ExtractedDocument → the Markdown block the model actually sees. Handles:
 *   - unit selection (pages/slides/sheets; 1-based)
 *   - XLSX row-range slicing (implemented on the column-letter table)
 *   - a 50 KB output cap with a continuation pointer
 *   - an outline prelude for caller-selected paths (@file large docs)
 */

import { basename } from "node:path"
import { MAX_OUTPUT_CHARS } from "./limits.js"
import type { ExtractedDocument } from "./model.js"

export interface RenderOptions {
	/** 1-based unit indices to include — undefined selects all. */
	unitIndices?: number[]
	/** XLSX row range ("20-60", 1-based spreadsheet rows) applied to sheet tables. */
	rows?: string
	maxChars?: number
	/** Where the output is going — used in the continuation hint. */
	toolName?: string
	path?: string
}

export interface RenderedDocument {
	text: string
	/** Total units in the document (before selection). */
	totalUnits: number
	/** Units actually included. */
	selectedUnits: number
	truncated: boolean
}

/** Parse "1-3,5,8-" into 1-based indices (open-ended tail means "to the end"). */
export function parseUnitRange(range: string, totalUnits: number): number[] | undefined {
	const out = new Set<number>()
	for (const part of range.split(",")) {
		const token = part.trim()
		if (!token) continue
		const m = /^(\d+)(?:-(\d*))?$/.exec(token)
		if (!m) return undefined
		const start = Number.parseInt(m[1], 10)
		if (start < 1) return undefined
		const end = m[2] === undefined ? start : m[2] === "" ? totalUnits : Number.parseInt(m[2], 10)
		if (end < start) return undefined
		for (let i = start; i <= Math.min(end, totalUnits); i++) out.add(i)
	}
	return out.size > 0 ? [...out].sort((a, b) => a - b) : undefined
}

/** Slice an XLSX markdown table to 1-based spreadsheet row numbers. */
export function sliceSheetRows(markdown: string, rowRange: string): string {
	const lines = markdown.split("\n")
	const m = /^(\d+)(?:-(\d+))?$/.exec(rowRange.trim())
	if (!m) return markdown
	const start = Number.parseInt(m[1], 10)
	const end = m[2] ? Number.parseInt(m[2], 10) : start
	const kept: string[] = []
	let seenHeader = false
	for (const line of lines) {
		if (!line.startsWith("|")) {
			kept.push(line)
			continue
		}
		const firstCell = /^\|\s*([^|]*)/.exec(line)?.[1].trim() ?? ""
		if (!seenHeader) {
			kept.push(line)
			if (firstCell === "") seenHeader = true // header row has empty row-number cell
			continue
		}
		if (/---/.test(firstCell)) {
			kept.push(line)
			continue
		}
		if (firstCell === "") {
			kept.push(line)
			continue
		}
		const rowNumber = Number.parseInt(firstCell, 10)
		if (Number.isNaN(rowNumber) || (rowNumber >= start && rowNumber <= end)) kept.push(line)
	}
	return kept.join("\n")
}

export function renderDocument(doc: ExtractedDocument, options: RenderOptions = {}): RenderedDocument {
	const maxChars = options.maxChars ?? MAX_OUTPUT_CHARS
	const units =
		options.unitIndices !== undefined ? doc.units.filter((u) => options.unitIndices?.includes(u.index)) : doc.units

	const header = headerFor(doc, options.path, units.length)
	const sections: string[] = []
	for (const unit of units) {
		let body = unit.markdown
		if (options.rows && doc.unitKind === "sheet") {
			body = sliceSheetRows(body, options.rows)
		}
		sections.push(`## ${unit.label}\n\n${body}`)
	}
	const notes = doc.notes.length > 0 ? `\n\nNotes: ${doc.notes.map((n) => `[${n}]`).join(" ")}` : ""

	let text = `${header}\n\n${sections.join("\n\n")}${notes}`.trim()
	let truncated = false
	if (text.length > maxChars) {
		text = `${text.slice(0, maxChars)}\n\n… output truncated at ${maxChars} characters — call ${options.toolName ?? "read_document"} again with a narrower range (pages/sheet/rows) to continue.`
		truncated = true
	}
	return { text, totalUnits: doc.units.length, selectedUnits: units.length, truncated }
}

/** Outline-only rendering for large documents (@file > 10 units). */
export function renderOutline(doc: ExtractedDocument, path: string): string {
	const lines = [
		`${basename(path)} (${doc.format}, ${doc.units.length} ${doc.unitKind}s) — outline:`,
		...doc.outline.map((line) => `- ${line}`),
		``,
		`Read specific ranges with read_document: { path: ${JSON.stringify(path)}, ${
			doc.unitKind === "page"
				? 'pages: "1-5"'
				: doc.unitKind === "slide"
					? 'pages: "1-5"'
					: 'sheet: "<name>", rows: "1-50"'
		} }`,
	]
	if (doc.notes.length > 0) lines.push(`Notes: ${doc.notes.map((n) => `[${n}]`).join(" ")}`)
	return lines.join("\n")
}

function headerFor(doc: ExtractedDocument, path: string | undefined, selected: number): string {
	const name = path ? basename(path) : "document"
	const where = selected === doc.units.length ? `${doc.units.length}` : `${selected} of ${doc.units.length}`
	return `# ${name} (${doc.format} — ${where} ${doc.unitKind}${doc.units.length === 1 ? "" : "s"})`
}
