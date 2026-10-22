/**
 * Surgical XLSX editing on the shared OOXML layer.
 *
 * All edits are string-level on worksheet XML (row spans via the extractor's
 * scan) and package-level for add-sheet — the untouched parts stay byte
 * identical. Formula writes remove cached values and set fullCalcOnLoad
 * (never recalculated in-process); value writes keep dependent cached values
 * stale and the caller is told. Merges touching a clear-range are refused.
 * Dropped cells vanish; no in-place writes.
 */

import { scanRowSpans } from "../extractors/xlsx.js"
import { applyXlfnPrefixes, lintFormula } from "../formula-lint.js"
import { DocumentError } from "../model.js"
import type { OoxmlPackage } from "../ooxml/package.js"
import { columnIndex, columnLetter, parseCellRef, parseRangeRef, splitSheetRef } from "../xlsx-refs.js"

export type SheetSelector = number | string

/** Same cell shape as the writer spec (value, formula, fmt, bold). */
export type EditCell =
	| string
	| number
	| boolean
	| null
	| { v?: string | number | boolean | null; f?: string; fmt?: string }

export type XlsxOp =
	| { kind: "set-cells"; sheet?: SheetSelector; cells: Record<string, EditCell> }
	| { kind: "clear-range"; sheet?: SheetSelector; range: string }
	| { kind: "append-rows"; sheet?: SheetSelector; rows: EditCell[][] }
	| { kind: "set-column-width"; sheet?: SheetSelector; columns: Record<string, number> }
	| { kind: "add-sheet"; name: string; after?: SheetSelector; rows?: EditCell[][] }
	| { kind: "rename-sheet"; sheet?: SheetSelector; name: string }
	| { kind: "delete-sheet"; sheet: SheetSelector }
	| { kind: "fill-formula"; sheet?: SheetSelector; range: string; formula: string }

export interface XlsxEditResult {
	applied: string[]
	/** Formula cells written without cached values (recalculated on open). */
	formulasWritten: number
	/** True if any formula existed/was written — dependent values may be stale. */
	formulasAlert: boolean
	/** Non-blocking lint findings (out-of-range refs, spill functions) — surfaced in summaries. */
	warnings: string[]
	/** Macros present round-trip untouched. */
	macrosPreserved: boolean
}

interface SheetLoc {
	index: number
	name: string
	part: string
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** Sheets in workbook order with their part paths. */
export function listSheetParts(pkg: OoxmlPackage): SheetLoc[] {
	const wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array())
	const rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels") ?? new Uint8Array())
	const targets: Record<string, string> = {}
	for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
		targets[m[1]] = m[2].startsWith("/") ? m[2].slice(1) : `xl/${m[2]}`
	}
	// Id and Target can appear in either attribute order — second pass by tag.
	for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
		const id = /\bId="([^"]+)"/.exec(m[1])?.[1]
		const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1]
		if (id && target) targets[id] = target.startsWith("/") ? target.slice(1) : `xl/${target}`
	}
	const out: SheetLoc[] = []
	for (const m of wb.matchAll(/<sheet\b([^>]*)\/>/g)) {
		const name = /\bname="([^"]*)"/.exec(m[1])?.[1]
		const relId = /\br:id="([^"]+)"/.exec(m[1])?.[1]
		const part = relId ? targets[relId] : undefined
		if (name && part) out.push({ index: out.length, name: unescName(name), part })
	}
	return out
}

/** Lint shapes with REAL last-row/last-column per sheet (row-span scan + last cell letter). */
function sheetShapes(pkg: OoxmlPackage): Array<{ name: string; lastRow: number; lastColumn: number }> {
	return listSheetParts(pkg).map((s) => {
		const bytes = pkg.getBytes(s.part)
		if (!bytes) return { name: s.name, lastRow: 1, lastColumn: 1 }
		const xml = new TextDecoder().decode(bytes)
		const spans = scanRowSpans(xml)
		const lastRow = spans.length > 0 ? spans[spans.length - 1].row : 1
		const lastSpan = spans[spans.length - 1]
		let lastColumn = 1
		if (lastSpan) {
			const refMatches = [...xml.slice(lastSpan.start, lastSpan.end).matchAll(/<c\b[^>]*\br="([A-Za-z]{1,3})/g)]
			const lastRef = refMatches[refMatches.length - 1]
			if (lastRef?.[1]) lastColumn = columnIndex(lastRef[1]) ?? 1
		}
		return { name: s.name, lastRow: Math.max(lastRow, 1), lastColumn }
	})
}

function unescName(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
}

function resolveSheet(pkg: OoxmlPackage, selector: SheetSelector | undefined): SheetLoc {
	const sheets = listSheetParts(pkg)
	if (sheets.length === 0) throw new DocumentError("corrupt", "workbook has no sheets", "xlsx")
	if (selector === undefined) return sheets[0]
	if (typeof selector === "number") {
		const sheet = sheets[selector - 1]
		if (!sheet) throw new DocumentError("corrupt", `No sheet ${selector} (workbook has ${sheets.length})`, "xlsx")
		return sheet
	}
	const lower = selector.toLowerCase()
	const sheet = sheets.find((s) => s.name.toLowerCase() === lower)
	if (!sheet) {
		throw new DocumentError(
			"corrupt",
			`No sheet named ${JSON.stringify(selector)} — sheets: ${sheets.map((s) => JSON.stringify(s.name)).join(", ")}`,
			"xlsx",
		)
	}
	return sheet
}

// --- cell-level string surgery ---------------------------------------------------------

interface CellSpan {
	ref: string
	full: string
	start: number
	end: number
	/** Attribute string minus the r="…" (keeps s="…" and t="…"). */
	attrs: string
	selfClosed: boolean
	inner: string
}

function scanCells(rowFrag: string): CellSpan[] {
	const spans: CellSpan[] = []
	const re = /<c\b((?:(?!\/?>)[^>])*)\/?(>)/g
	for (let m = re.exec(rowFrag); m !== null; m = re.exec(rowFrag)) {
		const attrs = m[1]
		const ref = /\br="([^"]+)"/.exec(attrs)?.[1]
		if (!ref) continue
		const fullOpen = m[0]
		if (fullOpen.endsWith("/>")) {
			spans.push({
				ref,
				full: fullOpen,
				start: m.index,
				end: m.index + fullOpen.length,
				attrs,
				selfClosed: true,
				inner: "",
			})
		} else {
			const close = rowFrag.indexOf("</c>", m.index)
			if (close < 0) throw new DocumentError("corrupt", `Unclosed <c r="${ref}">`, "xlsx")
			spans.push({
				ref,
				full: rowFrag.slice(m.index, close + 4),
				start: m.index,
				end: close + 4,
				attrs,
				selfClosed: false,
				inner: rowFrag.slice(m.index + fullOpen.length, close),
			})
		}
	}
	return spans
}

/** New <c> xml for a cell value; keeps the old s="…" attribute when present. */
function renderCell(ref: string, cell: EditCell, keepAttrs: string, addStyle?: number): string {
	const styleAttr = (() => {
		if (addStyle !== undefined) return ` s="${addStyle}"`
		// The preserved s= is digit-only; anything else from the (untrusted,
		// string-scanned) sheet is dropped rather than re-emitted raw.
		const s = /\bs="(\d+)"/.exec(keepAttrs)?.[1]
		return s !== undefined ? ` s="${s}"` : ""
	})()
	if (cell === null || cell === undefined) return ""
	if (typeof cell === "number") return `<c r="${ref}"${styleAttr}><v>${cell}</v></c>`
	if (typeof cell === "boolean") return `<c r="${ref}"${styleAttr} t="b"><v>${cell ? 1 : 0}</v></c>`
	if (typeof cell === "string")
		return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`
	if (cell.f !== undefined) {
		const f = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f
		return `<c r="${ref}"${styleAttr}><f>${esc(applyXlfnPrefixes(f))}</f></c>`
	}
	if (cell.v !== undefined && cell.v !== null) {
		if (typeof cell.v === "number") return `<c r="${ref}"${styleAttr}><v>${cell.v}</v></c>`
		if (typeof cell.v === "boolean") return `<c r="${ref}"${styleAttr} t="b"><v>${cell.v ? 1 : 0}</v></c>`
		return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`
	}
	return ""
}

/** Merge/validation surface of a sheet: merged ranges and dimension. */
interface SheetGeometry {
	merges: Array<{ start: { row: number; column: number }; end: { row: number; column: number } }>
}

function readGeometry(sheetXml: string): SheetGeometry {
	const merges: SheetGeometry["merges"] = []
	for (const m of sheetXml.matchAll(/<mergeCell\s+ref="([^"]+)"/g)) {
		const r = parseRangeRef(m[1])
		if (r) merges.push(r)
	}
	return { merges }
}

interface RowEdit {
	row: number
	replacements: Map<number, { ref: string; cell: EditCell }>
}

/**
 * Rewrites a sheet's string with a set of row edits (cell replacements and
 * deletions plus brand-new rows/cells). Returns the new xml string.
 */
function applyRowEdits(sheetXml: string, edits: RowEdit[]): { xml: string; touched: number } {
	const spans = scanRowSpans(sheetXml)
	const byRow = new Map(edits.map((e) => [e.row, e]))
	const parts: string[] = []
	let cursor = 0
	let touched = 0
	// Existing rows, in scan order.
	for (const span of spans) {
		const edit = byRow.get(span.row)
		if (!edit) continue
		parts.push(sheetXml.slice(cursor, span.start))
		const rowFrag = sheetXml.slice(span.start, span.end)
		const openEnd = rowFrag.indexOf(">")
		const open = rowFrag.slice(0, openEnd + 1)
		const newXml = rewriteRow(open, rowFrag.slice(openEnd + 1, rowFrag.length - "</row>".length), edit.replacements)
		parts.push(newXml)
		cursor = span.end
		touched++
		byRow.delete(span.row)
	}
	parts.push(sheetXml.slice(cursor))
	let xml = parts.join("")
	// Brand-new rows (row numbers the sheet doesn't have): append in order inside sheetData.
	const missing = [...byRow.values()].sort((a, b) => a.row - b.row)
	if (missing.length > 0) {
		const insertion = missing.map((e) => `<row r="${e.row}">${rewriteRowCells([], e.replacements)}</row>`).join("")
		const closeIdx = xml.lastIndexOf("</sheetData>")
		const openSelfclose = /<sheetData\s*\/>/.exec(xml)
		if (closeIdx >= 0) {
			xml = `${xml.slice(0, closeIdx)}${insertion}</sheetData>${xml.slice(closeIdx + "</sheetData>".length)}`
		} else if (openSelfclose) {
			xml = xml.replace(/<sheetData\s*\/>/, `<sheetData>${insertion}</sheetData>`)
		} else {
			throw new DocumentError("corrupt", "worksheet has no <sheetData>", "xlsx")
		}
		touched += missing.length
	}
	return { xml, touched }
}

function rewriteRow(
	openTag: string,
	inner: string,
	replacements: Map<number, { ref: string; cell: EditCell }>,
): string {
	return `${openTag}${rewriteRowCells(scanCellsFromInner(inner), replacements)}</row>`
}

interface CellLike {
	ref: string
	attrs: string
	inner: string
	full: string
}

function scanCellsFromInner(inner: string): CellLike[] {
	// inner is a row's cell sequence, e.g. <c …/><c …>…</c>.
	const cells: CellLike[] = []
	for (const span of scanCells(inner)) cells.push(span)
	return cells
}

function rewriteRowCells(existing: CellLike[], replacements: Map<number, { ref: string; cell: EditCell }>): string {
	const byRef = new Map(existing.map((c) => [c.ref.toUpperCase(), c]))
	const output: Array<{ col: number; xml: string; empty: boolean }> = []
	const handled = new Set<string>()
	for (const [col, rep] of [...replacements.entries()].sort((a, b) => a[0] - b[0])) {
		const ref = rep.ref.toUpperCase()
		const old = byRef.get(ref)
		const xml = renderCell(ref, rep.cell, old?.attrs ?? "")
		output.push({ col, xml, empty: xml === "" })
		handled.add(ref)
	}
	// Untouched existing cells stay, in original column order.
	for (const cell of existing) {
		if (!handled.has(cell.ref.toUpperCase())) {
			const col = parseCellRef(cell.ref)?.column
			if (col !== undefined) output.push({ col, xml: cell.full, empty: false })
		}
	}
	output.sort((a, b) => a.col - b.col)
	return output
		.filter((o) => !o.empty)
		.map((o) => o.xml)
		.join("")
}

/** Recompute the <dimension> from the cells present in the sheet xml. */
function updateDimension(sheetXml: string): string {
	// Recompute from row/cell refs.
	let maxRow = 0
	let maxCol = 0
	for (const m of sheetXml.matchAll(/<c\b[^>]*\br="([A-Z]{1,3})(\d+)"/g)) {
		maxCol = Math.max(maxCol, columnIndex((m[1] ?? "A").toUpperCase()) ?? 1)
		maxRow = Math.max(maxRow, Number(m[2] ?? 0))
	}
	for (const m of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"/g)) maxRow = Math.max(maxRow, Number(m[1] ?? 0))
	const dim =
		maxRow === 0 ? `<dimension ref="A1"/>` : `<dimension ref="A1:${columnLetter(Math.max(maxCol, 1))}${maxRow}"/>`
	if (/<dimension\b[^>]*\/>/.test(sheetXml)) return sheetXml.replace(/<dimension\b[^>]*\/>/, dim)
	if (/<dimension\b[^>]*>.*?<\/dimension>/.test(sheetXml))
		return sheetXml.replace(/<dimension\b[^>]*>.*?<\/dimension>/, dim)
	return sheetXml.replace(/<worksheet\b([^>]*)>/, `<worksheet$1>${dim}`)
}

function ensureFullCalcOnLoad(pkg: OoxmlPackage): void {
	const wbBytes = pkg.getBytes("xl/workbook.xml")
	if (!wbBytes) return
	let wb = new TextDecoder().decode(wbBytes)
	if (/<calcPr\b[^>]*\/>/.test(wb)) {
		wb = wb.replace(/<calcPr\b[^>]*\/>/, (m) => {
			return m.includes("fullCalcOnLoad") ? m : `${m.replace("/>", "")} fullCalcOnLoad="1"/>`
		})
	} else {
		wb = wb.replace(/<\/workbook>/, `<calcPr fullCalcOnLoad="1"/></workbook>`)
	}
	pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb))
}

function removeCalcChain(pkg: OoxmlPackage): void {
	if (pkg.hasXml("xl/calcChain.xml")) pkg.remove("xl/calcChain.xml")
}

// --- ops --------------------------------------------------------------------------------

export function applyXlsxOps(pkg: OoxmlPackage, ops: XlsxOp[]): XlsxEditResult {
	const result: XlsxEditResult = {
		applied: [],
		formulasWritten: 0,
		formulasAlert: false,
		warnings: [],
		macrosPreserved: pkg.hasXml("xl/vbaProject.bin"),
	}
	let formulasTouched = false

	for (const [opIndex, op] of ops.entries()) {
		switch (op.kind) {
			case "set-cells": {
				const sheet = resolveSheet(pkg, op.sheet)
				const xmlBytes = pkg.getBytes(sheet.part)
				if (!xmlBytes) throw new DocumentError("corrupt", `missing sheet part ${sheet.part}`, "xlsx")
				let xml = new TextDecoder().decode(xmlBytes)
				const edits = new Map<number, RowEdit>()
				for (const [key, cell] of Object.entries(op.cells)) {
					const { sheet: sheetName, ref } = splitSheetRef(key)
					if (sheetName !== undefined && sheetName.toLowerCase() !== sheet.name.toLowerCase()) {
						throw new DocumentError(
							"corrupt",
							`op ${opIndex + 1}: cell ${key} names a different sheet than --sheet`,
							"xlsx",
						)
					}
					const parsed = parseCellRef(ref)
					if (!parsed)
						throw new DocumentError("corrupt", `op ${opIndex + 1}: bad cell ref ${JSON.stringify(key)}`, "xlsx")
					const hasFormula = typeof cell === "object" && cell !== null && cell.f !== undefined
					if (hasFormula) {
						const findings = lintFormula(
							(cell as { f: string }).f,
							ref,
							sheetShapes(pkg),
							sheetShapes(pkg)[sheet.index],
						)
						const hard = findings.filter(
							(f) => f.rule === "unbalanced-syntax" || f.rule === "unknown-sheet" || f.rule === "unknown-function",
						)
						if (hard.length > 0) {
							throw new DocumentError(
								"corrupt",
								`op ${opIndex + 1} ${ref}: ${hard.map((f) => `[${f.rule}] ${f.message}`).join("; ")}`,
								"xlsx",
							)
						}
						for (const soft of findings) {
							if (soft.rule === "out-of-range-ref" || soft.rule === "spill-function") {
								result.warnings.push(`op ${opIndex + 1} ${ref} (${soft.rule}): ${soft.message}`)
							}
						}
						formulasTouched = true
						result.formulasWritten++
					}
					if (cell !== null && typeof cell === "object" && cell.fmt !== undefined) {
						throw new DocumentError(
							"corrupt",
							`op ${opIndex + 1} ${ref}: changing number formats isn't supported by edit (set values and re-run create for style changes)`,
							"xlsx",
						)
					}
					let rowEdit = edits.get(parsed.row)
					if (!rowEdit) {
						rowEdit = { row: parsed.row, replacements: new Map() }
						edits.set(parsed.row, rowEdit)
					}
					rowEdit.replacements.set(parsed.column, { ref, cell })
				}
				const { xml: newXml, touched } = applyRowEdits(xml, [...edits.values()])
				xml = updateDimension(newXml)
				pkg.putBytes(sheet.part, new TextEncoder().encode(xml))
				result.applied.push(
					`op ${opIndex + 1} set-cells: sheet ${JSON.stringify(sheet.name)}, ${Object.keys(op.cells).length} cell(s) across ${touched} row(s)`,
				)
				break
			}
			case "clear-range": {
				const sheet = resolveSheet(pkg, op.sheet)
				const { sheet: rangeSheet, ref } = splitSheetRef(op.range)
				if (rangeSheet !== undefined) {
					const other = resolveSheet(pkg, rangeSheet)
					if (other.name !== sheet.name)
						throw new DocumentError(
							"corrupt",
							`op ${opIndex + 1}: range names ${other.name}, sheet is ${sheet.name}`,
							"xlsx",
						)
				}
				const range = parseRangeRef(ref)
				if (!range)
					throw new DocumentError("corrupt", `op ${opIndex + 1}: bad range ${JSON.stringify(op.range)}`, "xlsx")
				let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array())
				const { merges } = readGeometry(xml)
				for (const merge of merges) {
					const overlaps =
						merge.start.row <= range.end.row &&
						merge.end.row >= range.start.row &&
						merge.start.column <= range.end.column &&
						merge.end.column >= range.start.column
					if (overlaps) {
						throw new DocumentError(
							"corrupt",
							`op ${opIndex + 1}: range ${op.range} overlaps merged cells "${columnLetter(merge.start.column)}${merge.start.row}:${columnLetter(merge.end.column)}${merge.end.row}" — unmerge manually or pick a different range`,
							"xlsx",
						)
					}
				}
				const spans = scanRowSpans(xml)
				const edits: RowEdit[] = []
				for (let r = range.start.row; r <= range.end.row; r++) {
					if (!spans.some((s) => s.row === r)) continue
					const replacements = new Map<number, { ref: string; cell: EditCell }>()
					for (let c = range.start.column; c <= range.end.column; c++) {
						replacements.set(c, { ref: `${columnLetter(c)}${r}`, cell: null })
					}
					edits.push({ row: r, replacements })
				}
				const { xml: newXml, touched } = applyRowEdits(xml, edits)
				xml = updateDimension(newXml)
				pkg.putBytes(sheet.part, new TextEncoder().encode(xml))
				result.applied.push(
					`op ${opIndex + 1} clear-range: sheet ${JSON.stringify(sheet.name)}, ${touched} row(s) trimmed`,
				)
				break
			}
			case "append-rows": {
				const sheet = resolveSheet(pkg, op.sheet)
				let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array())
				const spans = scanRowSpans(xml)
				const lastRow = spans.length > 0 ? spans[spans.length - 1].row : 0
				const edits: RowEdit[] = op.rows.map((cells, i) => ({
					row: lastRow + 1 + i,
					replacements: new Map(
						cells.map((cell, ci) => {
							const parsed = { column: ci + 1, row: lastRow + 1 + i }
							const hasFormula = typeof cell === "object" && cell !== null && cell.f !== undefined
							if (hasFormula) {
								formulasTouched = true
								result.formulasWritten++
							}
							return [ci + 1, { ref: `${columnLetter(parsed.column)}${parsed.row}`, cell }]
						}),
					),
				}))
				const { xml: newXml } = applyRowEdits(xml, edits)
				xml = updateDimension(newXml)
				pkg.putBytes(sheet.part, new TextEncoder().encode(xml))
				result.applied.push(
					`op ${opIndex + 1} append-rows: sheet ${JSON.stringify(sheet.name)}, ${op.rows.length} row(s) starting at ${lastRow + 1}`,
				)
				break
			}
			case "set-column-width": {
				const sheet = resolveSheet(pkg, op.sheet)
				let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array())
				const newCols = new Map<number, number>()
				for (const [letter, width] of Object.entries(op.columns)) {
					const col = columnIndex(letter.toUpperCase())
					if (col === undefined)
						throw new DocumentError("corrupt", `bad column letter ${JSON.stringify(letter)}`, "xlsx")
					if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > 256) {
						throw new DocumentError(
							"corrupt",
							`column ${letter}: width must be a finite number in (0, 256], got ${JSON.stringify(width)}`,
							"xlsx",
						)
					}
					newCols.set(col, width)
				}
				const existing: Array<{ min: number; max: number; width: number }> = []
				const colsMatch = /<cols>([\s\S]*?)<\/cols>/.exec(xml)
				if (colsMatch) {
					for (const m of (colsMatch[1] ?? "").matchAll(/<col\b([^>]*)\/>/g)) {
						const attrs = m[1] ?? ""
						const min = Number(/\bmin="(\d+)"/.exec(attrs)?.[1] ?? 0)
						const max = Number(/\bmax="(\d+)"/.exec(attrs)?.[1] ?? 0)
						const width = Number(/\bwidth="([\d.]+)"/.exec(attrs)?.[1] ?? 8.43)
						existing.push({ min, max, width })
					}
				}
				for (const [col, width] of newCols) existing.push({ min: col, max: col, width })
				const colsXml = `<cols>${existing
					.sort((a, b) => a.min - b.min)
					.map((c) => `<col min="${c.min}" max="${c.max}" width="${c.width}" customWidth="1"/>`)
					.join("")}</cols>`
				if (colsMatch) xml = xml.replace(colsMatch[0], colsXml)
				else xml = xml.replace(/(<sheetFormatPr\b[^>]*\/>|<dimension\b[^>]*\/>)/, `$1${colsXml}`)
				pkg.putBytes(sheet.part, new TextEncoder().encode(xml))
				result.applied.push(
					`op ${opIndex + 1} set-column-width: sheet ${JSON.stringify(sheet.name)}, ${[...newCols.keys()].map(columnLetter).join(", ")}`,
				)
				break
			}
			case "add-sheet": {
				result.applied.push(
					addSheet(pkg, op, () => {
						formulasTouched = true
					}),
				)
				break
			}
			case "rename-sheet": {
				const sheet = resolveSheet(pkg, op.sheet)
				const newName = op.name?.trim()
				if (!newName)
					throw new DocumentError("corrupt", `op ${opIndex + 1}: rename-sheet needs a non-empty "name"`, "xlsx")
				if (newName.length > 31 || /[[\]:*?/\\]/.test(newName)) {
					throw new DocumentError("corrupt", `op ${opIndex + 1}: bad sheet name ${JSON.stringify(op.name)}`, "xlsx")
				}
				const sheets = listSheetParts(pkg)
				if (sheets.some((s) => s.name.toLowerCase() === newName.toLowerCase())) {
					throw new DocumentError(
						"corrupt",
						`op ${opIndex + 1}: a sheet named ${JSON.stringify(newName)} already exists`,
						"xlsx",
					)
				}
				const oldName = sheet.name
				let wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array())
				wb = wb.replace(/(<sheet\b[^>]*\bname=")([^"]*)(")/g, (m, pre, name, post) =>
					unescName(name) === oldName ? `${pre}${esc(newName)}${post}` : m,
				)
				pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb))
				// Rewrite formula references in every sheet part ('Old'! / Old!).
				const quotedOld = `'${oldName.replace(/'/g, "''")}'`
				const quotedNew = `'${newName.replace(/'/g, "''")}'`
				const bareOldEscaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				for (const loc of listSheetParts(pkg)) {
					const bytes = pkg.getBytes(loc.part)
					if (!bytes) continue
					let partXml = new TextDecoder().decode(bytes)
					let changed = false
					if (partXml.includes(`${quotedOld}!`)) {
						partXml = partXml.split(`${quotedOld}!`).join(`${quotedNew}!`)
						changed = true
					}
					const bare = new RegExp(`(?<![A-Za-z0-9_'!.])${bareOldEscaped}!`, "g")
					const next = partXml.replace(bare, () => {
						changed = true
						return `${newName}!`
					})
					if (changed) {
						pkg.putBytes(loc.part, new TextEncoder().encode(next))
						formulasTouched = true
					}
				}
				result.applied.push(
					`op ${opIndex + 1} rename-sheet: ${JSON.stringify(oldName)} -> ${JSON.stringify(newName)} (formula references updated)`,
				)
				break
			}
			case "delete-sheet": {
				const sheet = resolveSheet(pkg, op.sheet)
				const sheets = listSheetParts(pkg)
				if (sheets.length <= 1) throw new DocumentError("corrupt", "cannot delete the only sheet", "xlsx")
				// Refuse when any remaining formula references it — the formula would go #REF!.
				const quotedOld = `'${sheet.name.replace(/'/g, "''")}'`
				const bareOldEscaped = sheet.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				const referring: string[] = []
				for (const loc of sheets) {
					if (loc.part === sheet.part) continue
					const xml = new TextDecoder().decode(pkg.getBytes(loc.part) ?? new Uint8Array())
					if (xml.includes(`${quotedOld}!`) || new RegExp(`(?<![A-Za-z0-9_'!.])${bareOldEscaped}!`).test(xml)) {
						referring.push(loc.name)
					}
				}
				if (referring.length > 0) {
					throw new DocumentError(
						"corrupt",
						`op ${opIndex + 1}: sheet ${JSON.stringify(sheet.name)} is referenced by formulas in ${referring.map((s) => JSON.stringify(s)).join(", ")} — clear those refs first`,
						"xlsx",
					)
				}
				// workbook.xml: drop the <sheet> tag
				let wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array())
				wb = wb.replace(/<sheet\b[^>]*\/>/g, (m) => (m.includes(`name="${esc(sheet.name)}"`) ? "" : m))
				pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb))
				// rels: drop the relationship; content types: drop the override; then remove the part.
				let rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels") ?? new Uint8Array())
				rels = rels.replace(/<Relationship\b[^>]*\/>/g, (m) =>
					m.includes(`Target="${sheet.part.replace(/^xl\//, "").replace(/\//g, "/")}"`) ? "" : m,
				)
				pkg.putBytes("xl/_rels/workbook.xml.rels", new TextEncoder().encode(rels))
				let ct = new TextDecoder().decode(pkg.getBytes("[Content_Types].xml") ?? new Uint8Array())
				ct = ct.replace(/<Override\b[^>]*\/>/g, (m) => (m.includes(`PartName="/${sheet.part}"`) ? "" : m))
				pkg.putBytes("[Content_Types].xml", new TextEncoder().encode(ct))
				pkg.remove(sheet.part)
				result.applied.push(
					`op ${opIndex + 1} delete-sheet: ${JSON.stringify(sheet.name)} (part ${sheet.part} removed)`,
				)
				break
			}
			case "fill-formula": {
				const sheet = resolveSheet(pkg, op.sheet)
				const { sheet: rangeSheet, ref } = splitSheetRef(op.range)
				if (rangeSheet !== undefined) {
					const other = resolveSheet(pkg, rangeSheet)
					if (other.name !== sheet.name)
						throw new DocumentError(
							"corrupt",
							`op ${opIndex + 1}: range names ${other.name}, sheet is ${sheet.name}`,
							"xlsx",
						)
				}
				let xml = new TextDecoder().decode(pkg.getBytes(sheet.part) ?? new Uint8Array())
				const range = parseRangeRef(ref)
				if (!range)
					throw new DocumentError("corrupt", `op ${opIndex + 1}: bad range ${JSON.stringify(op.range)}`, "xlsx")
				let count = 0
				const edits: RowEdit[] = []
				for (let r = range.start.row; r <= range.end.row; r++) {
					const replacements = new Map<number, { ref: string; cell: EditCell }>()
					for (let c = range.start.column; c <= range.end.column; c++) {
						const refC = `${columnLetter(c)}${r}`
						const expanded = op.formula.replace(/\{col\}/g, columnLetter(c)).replace(/\{row\}/g, String(r))
						const cellEdit: EditCell = { f: expanded }
						replacements.set(c, { ref: refC, cell: cellEdit })
						count++
						result.formulasWritten++
					}
					edits.push({ row: r, replacements })
				}
				const { xml: newXml } = applyRowEdits(xml, edits)
				xml = updateDimension(newXml)
				pkg.putBytes(sheet.part, new TextEncoder().encode(xml))
				formulasTouched = true
				result.applied.push(
					`op ${opIndex + 1} fill-formula: sheet ${JSON.stringify(sheet.name)}, ${count} formula(s) in ${op.range}`,
				)
				break
			}
			default:
				throw new DocumentError("corrupt", `unknown op kind ${(op as { kind?: string }).kind}`, "xlsx")
		}
	}

	if (formulasTouched) {
		removeCalcChain(pkg)
		ensureFullCalcOnLoad(pkg)
		result.formulasAlert = true
	}
	return result
}

function addSheet(
	pkg: OoxmlPackage,
	op: { name: string; after?: SheetSelector; rows?: EditCell[][] },
	onFormula: () => void,
): string {
	const sheets = listSheetParts(pkg)
	if (sheets.some((s) => s.name.toLowerCase() === op.name.toLowerCase())) {
		throw new DocumentError("corrupt", `a sheet named ${JSON.stringify(op.name)} already exists`, "xlsx")
	}
	if (op.name.length > 31 || /[[\]:*?/\\]/.test(op.name)) {
		throw new DocumentError("corrupt", `bad sheet name ${JSON.stringify(op.name)} (forbidden chars or >31)`, "xlsx")
	}
	const newIndex = sheets.length
	// The generated part path must not collide with an existing member —
	// hostile rel targets can point sheets anywhere, so pick a free name.
	let partOrdinal = newIndex + 1
	while (pkg.getBytes(`xl/worksheets/sheet${partOrdinal}.xml`) !== undefined) partOrdinal++
	// Relationships: next free rId
	let rels = new TextDecoder().decode(pkg.getBytes("xl/_rels/workbook.xml.rels") ?? new Uint8Array())
	const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))
	const newId = `rId${Math.max(sheets.length, 0, ...ids) + 1}`
	const partName = `xl/worksheets/sheet${partOrdinal}.xml`
	rels = rels.replace(
		/<\/Relationships>/,
		`<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${partOrdinal}.xml"/></Relationships>`,
	)
	pkg.putBytes("xl/_rels/workbook.xml.rels", new TextEncoder().encode(rels))

	// workbook.xml — insert after the requested sheet (default: at the end).
	let wb = new TextDecoder().decode(pkg.getBytes("xl/workbook.xml") ?? new Uint8Array())
	const afterIndex =
		op.after === undefined
			? sheets.length
			: sheets.findIndex((s) =>
					typeof op.after === "number"
						? s.index === (op.after as number) - 1
						: s.name.toLowerCase() === String(op.after).toLowerCase(),
				) + 1
	const newSheetTag = `<sheet name="${esc(op.name)}" sheetId="${newIndex + 1}" r:id="${newId}"/>`
	const sheetTags = [...wb.matchAll(/<sheet\b[^>]*\/>/g)]
	if (afterIndex <= 0 || sheetTags.length === 0) {
		wb = wb.replace(/<sheets>/, `<sheets>${newSheetTag}`)
	} else if (afterIndex >= sheetTags.length) {
		const last = sheetTags[sheetTags.length - 1]
		const at = (last.index ?? 0) + last[0].length
		wb = `${wb.slice(0, at)}${newSheetTag}${wb.slice(at)}`
	} else {
		const prev = sheetTags[afterIndex - 1]
		const at = (prev.index ?? 0) + prev[0].length
		wb = `${wb.slice(0, at)}${newSheetTag}${wb.slice(at)}`
	}
	pkg.putBytes("xl/workbook.xml", new TextEncoder().encode(wb))

	// [Content_Types].xml
	let ct = new TextDecoder().decode(pkg.getBytes("[Content_Types].xml") ?? new Uint8Array())
	ct = ct.replace(
		/<\/Types>/,
		`<Override PartName="/xl/worksheets/sheet${partOrdinal}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
	)
	pkg.putBytes("[Content_Types].xml", new TextEncoder().encode(ct))

	// The new sheet part.
	let rowsXml = ""
	let formulas = 0
	for (const [ri, row] of (op.rows ?? []).entries()) {
		const r = ri + 1
		const cells: string[] = []
		for (const [ci, cell] of row.entries()) {
			const ref = `${columnLetter(ci + 1)}${r}`
			if (cell !== null && typeof cell === "object" && cell.f !== undefined) {
				formulas++
				onFormula()
				cells.push(renderCell(ref, cell, ""))
			} else cells.push(renderCell(ref, cell, ""))
		}
		if (cells.length > 0) rowsXml += `<row r="${r}">${cells.join("")}</row>`
	}
	const lastRow = (op.rows ?? []).length
	const lastCol = Math.max(1, ...(op.rows ?? []).map((r) => r.length))
	const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${columnLetter(lastCol)}${Math.max(lastRow, 1)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>${rowsXml}</sheetData></worksheet>`
	pkg.putBytes(partName, new TextEncoder().encode(sheetXml))
	return `add-sheet: ${JSON.stringify(op.name)} at position ${Math.min(afterIndex, sheetTags.length + 1)}${formulas > 0 ? `, ${formulas} formula(s)` : ""} (op)`
}
