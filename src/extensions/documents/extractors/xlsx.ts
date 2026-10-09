/**
 * XLSX/XLS/ODS/CSV extractor via SheetJS CE (read-only — it drops styles on
 * write, and v1 never writes through it).
 *
 * Determinism: cell TEXT is taken from SheetJS's cached formatted string
 * (`w`) produced from the cell's number format code, never from locale
 * defaults; Excel date serials are formatted by format codes (UTC-anchored,
 * 1900/1904 systems both handled by SSF). This is what makes TZ/LANG
 * variations a no-op — the test matrix in accuracy.test.ts proves it.
 */

import * as XLSX from "xlsx"
import { renderMarkdownTable } from "../markdown-table.js"
import { DocumentError, type DocumentFormat, type DocumentUnit, type ExtractedDocument } from "../model.js"

export interface XlsxExtractOptions {
	/** Show formula strings instead of computed values where present. */
	formulas?: boolean
}

export function extractXlsxLike(
	data: Uint8Array | string,
	format: DocumentFormat,
	options: XlsxExtractOptions = {},
): ExtractedDocument {
	let wb: XLSX.WorkBook
	try {
		wb = XLSX.read(data, {
			type: typeof data === "string" ? "string" : "array",
			// raw=false below uses cached formatted text; cellDates formats
			// serials from their format codes (deterministic, TZ-free).
			cellDates: false,
			cellNF: true,
			cellFormula: true,
			cellStyles: false,
			bookSheets: false,
			raw: false,
		})
	} catch (err) {
		throw new DocumentError("corrupt", `Not a readable ${format.toUpperCase()}: ${(err as Error).message}`, format)
	}

	const notes: string[] = []
	const units: DocumentUnit[] = []
	const outline: string[] = []
	const hidden = hiddenSheets(wb)

	wb.SheetNames.forEach((name, i) => {
		const ws = wb.Sheets[name]
		if (!ws) return
		const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : undefined
		if (!range) {
			units.push({ index: i + 1, label: `Sheet: ${name}`, name, markdown: "(empty sheet)" })
			outline.push(`Sheet ${i + 1} "${name}": empty`)
			return
		}
		const rows: string[][] = extractRows(ws, range, options.formulas ?? false)
		const header = ["", ...columnLetters(range.s.c, range.e.c)]
		const mdLines = renderMarkdownTable(header, rows)
		let markdown = mdLines
		if (hidden.has(name)) {
			notes.push(`sheet "${name}" is hidden`)
			markdown = `*hidden sheet*\n\n${mdLines}`
		}
		units.push({ index: i + 1, label: `Sheet: ${name}`, name, markdown })
		outline.push(`Sheet ${i + 1} "${name}": ${range.e.r - range.s.r + 1} rows × ${range.e.c - range.s.c + 1} cols`)
	})
	if (units.length === 0) {
		throw new DocumentError("corrupt", `${format.toUpperCase()} has no sheets.`, format)
	}
	return { format, unitKind: format === "csv" ? "document" : "sheet", units, outline, notes }
}

function extractRows(ws: XLSX.WorkSheet, range: XLSX.Range, formulas: boolean): string[][] {
	const rows: string[][] = []
	for (let r = range.s.r; r <= range.e.r; r++) {
		const row: string[] = [String(r + 1)]
		for (let c = range.s.c; c <= range.e.c; c++) {
			const addr = XLSX.utils.encode_cell({ r, c })
			const cell = ws[addr] as XLSX.CellObject | undefined
			let text = ""
			if (cell) {
				if (formulas && cell.f) {
					text = `=${cell.f}`
				} else if (typeof cell.w === "string") {
					// Cached formatted text (deterministic from the number format).
					text = cell.w
				} else if (cell.v !== undefined) {
					text = formatRawValue(cell.v, cell.t)
				}
			}
			row.push(text)
		}
		rows.push(row)
	}
	return rows
}

function formatRawValue(v: unknown, _t: XLSX.ExcelDataType): string {
	if (typeof v === "number") return String(v)
	if (v instanceof Date) return v.toISOString()
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
	return String(v)
}

function columnLetters(start: number, end: number): string[] {
	const letters: string[] = []
	for (let c = start; c <= end; c++) letters.push(XLSX.utils.encode_col(c))
	return letters
}

function hiddenSheets(wb: XLSX.WorkBook): Set<string> {
	const hidden = new Set<string>()
	const sheets = wb.Workbook?.Sheets
	if (Array.isArray(sheets)) {
		sheets.forEach((meta, i) => {
			if (meta?.Hidden && meta.Hidden > 0) {
				const name = wb.SheetNames[i]
				if (name) hidden.add(name)
			}
		})
	}
	return hidden
}
