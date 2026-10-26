/**
 * Own-code XLSX writer on jszip (no ExcelJS, per the workstream decision).
 * Writes the smallest complete, Office-valid workbook:
 *
 *   [Content_Types].xml, _rels/.rels, xl/workbook.xml (+ rels), styles.xml
 *   with a real default style + bold header font + one numFmt per distinct
 *   format code (from 164), worksheets with merged values, inline strings,
 *   column widths, and a frozen header row.
 *
 * Formulas: written without cached values, `fullCalcOnLoad` set and NO
 * calcChain part — Excel/office recalculates on open. lintFormula runs on
 * every formula first; `_xlfn.` prefixes are added for post-2007 functions.
 * Spill-function findings are returned as warnings, not errors.
 */

import JSZip from "jszip"
import { type DocumentClock, RealClock } from "../clock.js"
import { applyXlfnPrefixes, lintFormula, type SheetShape } from "../formula-lint.js"
import { DocumentError } from "../model.js"
import { columnLetter, validateSheetName } from "../xlsx-refs.js"

/** Spec cell: a plain scalar, or an object with explicit parts. */
export type SpecCell =
	| string
	| number
	| boolean
	| null
	| {
			v?: string | number | boolean | null
			/** Formula WITHOUT the leading = (both accepted). */
			f?: string
			/** number format code, e.g. "0.00%" or "yyyy-mm-dd". */
			fmt?: string
			bold?: boolean
	  }

export interface SpecSheet {
	name: string
	rows: SpecCell[][]
	/** Freeze the first row. Default false. */
	freezeHeader?: boolean
	/** Column widths keyed by index (1-based) in character units. */
	columnWidths?: Record<number, number>
}

export interface XlsxSpec {
	sheets: SpecSheet[]
	title?: string
}

export interface WriteXlsxResult {
	bytes: Uint8Array
	warnings: string[]
	formulas: number
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

function validateSpec(spec: XlsxSpec): void {
	if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
		throw new DocumentError("corrupt", "spec needs at least one sheet", "xlsx")
	}
	const seen = new Set<string>()
	for (const sheet of spec.sheets) {
		if (typeof sheet.name !== "string" || sheet.name.trim() === "") {
			throw new DocumentError("corrupt", "every sheet needs a non-empty name", "xlsx")
		}
		const nameError = validateSheetName(sheet.name)
		if (nameError) throw new DocumentError("corrupt", nameError, "xlsx")
		const key = sheet.name.toLowerCase()
		if (seen.has(key)) throw new DocumentError("corrupt", `duplicate sheet name ${JSON.stringify(sheet.name)}`, "xlsx")
		seen.add(key)
		if (!Array.isArray(sheet.rows))
			throw new DocumentError("corrupt", `sheet ${sheet.name}: rows must be an array`, "xlsx")
	}
}

/** Cell → OOXML cell xml + bookkeeping. */
interface WrittenCell {
	xml: string
	empty: boolean
}

// --- styles ---------------------------------------------------------------------------

interface StyleSet {
	stylesXml: string
	fontIdForBold: number
	xfsCount: number
	/** numFmtId (>=164 or built-in) keyed by formatCode. */
	numFmtIds: Map<string, number>
}

/** Known built-in ids so common codes reuse them. */
const BUILTIN_FMT_IDS: Record<string, number> = {
	General: 0,
	"0": 1,
	"0.00": 2,
	"#,##0": 3,
	"#,##0.00": 4,
	"0%": 9,
	"0.00%": 10,
	"mm-dd-yy": 14,
	"d-mmm-yy": 15,
	"d-mmm": 16,
	"mmm-yy": 17,
	"h:mm AM/PM": 18,
	"h:mm:ss AM/PM": 19,
	"h:mm": 20,
	"h:mm:ss": 21,
	"m/d/yy h:mm": 22,
	"#,##0 ;(#,##0)": 37,
	"#,##0_);(#,##0)": 37,
	"#,##0 ;[Red](#,##0)": 38,
	"#,##0.00;(#,##0.00)": 39,
	"#,##0.00;[Red](#,##0.00)": 40,
	"mm:ss": 45,
	"[h]:mm:ss": 46,
	"mmss.0": 47,
	"##0.0E+0": 48,
	"@": 49,
}

/** Styles: 0 default, 1 bold, then one xf per distinct custom fmt (+ bold variants unused in v1). */
function buildStyles(codes: string[]): StyleSet {
	const numFmtIds = new Map<string, number>()
	let nextCustomId = 164
	for (const code of codes) {
		if (numFmtIds.has(code)) continue
		numFmtIds.set(code, BUILTIN_FMT_IDS[code] ?? nextCustomId++)
	}
	const customs = codes.filter((c) => BUILTIN_FMT_IDS[c] === undefined)
	// xfs: 0 = plain, 1 = bold, then 2..n one per distinct code.
	const numFmtsXml =
		customs.length > 0
			? `<numFmts count="${customs.length}">${customs
					.map((code) => `<numFmt numFmtId="${numFmtIds.get(code)}" formatCode="${esc(code)}"/>`)
					.join("")}</numFmts>`
			: ""
	const xfs = [
		'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
		'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
		...codes.map(
			(code, i) =>
				`<xf numFmtId="${numFmtIds.get(code)}" fontId="0" fillId="0" borderId="0" xfId="${i === 0 ? 1 : 1}" applyNumberFormat="1"/>`,
		),
	]
	const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmtsXml}
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`
	return { stylesXml, fontIdForBold: 1, xfsCount: xfs.length, numFmtIds }
}

// --- sheet xml --------------------------------------------------------------------------

function sheetXml(
	sheet: SpecSheet,
	styles: StyleSet,
	sheetIndex: number,
	shapes: SheetShape,
	lint: (formula: string, cell: string) => void,
): { xml: string; formulas: number } {
	const formulas = 0
	const rowsXml: string[] = []
	for (const [ri, row] of sheet.rows.entries()) {
		const r = ri + 1
		const cells: string[] = []
		for (const [ci, cell] of row.entries()) {
			const col = ci + 1
			const ref = `${columnLetter(col)}${r}`
			const written = writeCell(cell, ref, styles, lint)
			if (!written.empty) cells.push(written.xml)
		}
		if (cells.length > 0) rowsXml.push(`<row r="${r}">${cells.join("")}</row>`)
	}
	const lastRow = Math.max(shapes.lastRow, 1)
	const lastCol = columnLetter(Math.max(shapes.lastColumn, 1))
	const views = sheet.freezeHeader
		? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>`
		: `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`
	const cols = sheet.columnWidths
		? `<cols>${Object.entries(sheet.columnWidths)
				.sort((a, b) => Number(a[0]) - Number(b[0]))
				.map(([idx, w]) => `<col min="${idx}" max="${idx}" width="${w}" customWidth="1"/>`)
				.join("")}</cols>`
		: ""
	void sheetIndex
	void formulas
	const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
${views}
${cols}
<sheetData>${rowsXml.join("")}</sheetData>
</worksheet>`
	return { xml, formulas }
}

function writeCell(
	cell: SpecCell,
	ref: string,
	styles: StyleSet,
	lint: (formula: string, cell: string) => void,
): WrittenCell {
	if (cell === null || cell === undefined) return { xml: "", empty: true }
	if (typeof cell === "number") {
		if (!Number.isFinite(cell)) throw new DocumentError("corrupt", `cell ${ref}: non-finite number`, "xlsx")
		return { xml: `<c r="${ref}"><v>${cell}</v></c>`, empty: false }
	}
	if (typeof cell === "boolean") return { xml: `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`, empty: false }
	if (typeof cell === "string") {
		if (cell.startsWith("=")) return formulaCell(cell.slice(1), ref, lint) // shorthand
		return { xml: `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`, empty: false }
	}
	// Shorthand: strings starting "=" are formulas? no — explicit: strings are text.
	if (cell.f !== undefined) {
		const formula = cell.f.startsWith("=") ? cell.f.slice(1) : cell.f
		lint(formula, ref)
		return { xml: `<c r="${ref}"><f>${esc(applyXlfnPrefixes(formula))}</f></c>`, empty: false }
	}
	const s = cell.fmt !== undefined ? styleIndexFor(styles, String(cell.fmt), cell.bold === true) : cell.bold ? 1 : 0
	if (cell.v !== undefined && cell.v !== null) {
		if (typeof cell.v === "number")
			return { xml: `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${cell.v}</v></c>`, empty: false }
		if (typeof cell.v === "boolean")
			return { xml: `<c r="${ref}"${s ? ` s="${s}"` : ""} t="b"><v>${cell.v ? 1 : 0}</v></c>`, empty: false }
		return {
			xml: `<c r="${ref}"${s ? ` s="${s}"` : ""} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`,
			empty: false,
		}
	}
	return { xml: "", empty: true }
}

function formulaCell(formula: string, ref: string, lint: (formula: string, cell: string) => void): WrittenCell {
	lint(formula, ref)
	return { xml: `<c r="${ref}"><f>${esc(applyXlfnPrefixes(formula))}</f></c>`, empty: false }
}

/** xfs index for (fmt, bold): plain fmt lives at 2+i; bold+fmt is out of v1
 *  (a bold cell with a date format is rare) — header style wins? Decide:
 *  bold takes style 1 and drops fmt? No: surface this honestly by an error. */
function styleIndexFor(styles: StyleSet, code: string, bold: boolean): number {
	const i = [...styles.numFmtIds.keys()].indexOf(code)
	if (i < 0) throw new DocumentError("corrupt", `internal: style not predeclared for format ${code}`, "xlsx")
	if (bold) {
		throw new DocumentError(
			"corrupt",
			`cells can be bold OR carry a number format in v1, not both (${code}) — split the style`,
			"xlsx",
		)
	}
	return 2 + i
}

export async function writeXlsx(spec: XlsxSpec, options: { clock?: DocumentClock } = {}): Promise<WriteXlsxResult> {
	const clock = options.clock ?? RealClock
	validateSpec(spec)

	// Pre-collect format codes so styles are stable regardless of cell order.
	const codes: string[] = []
	const collect = (cell: SpecCell) => {
		if (cell !== null && typeof cell === "object" && cell.fmt !== undefined) {
			const code = String(cell.fmt)
			if (!codes.includes(code)) codes.push(code)
		}
	}
	for (const sheet of spec.sheets) for (const row of sheet.rows) for (const cell of row) collect(cell)
	const styles = buildStyles(codes)

	const shapes: SheetShape[] = spec.sheets.map((sheet) => ({
		name: sheet.name,
		lastRow: sheet.rows.length,
		lastColumn: Math.max(1, ...sheet.rows.map((r) => r.length)),
	}))

	const warnings: string[] = []
	let formulas = 0
	const parts = spec.sheets.map((sheet, i) => {
		const lint = (formula: string, cell: string) => {
			formulas++
			const findings = lintFormula(formula, cell, shapes, shapes[i])
			const hard = findings.filter(
				(f) => f.rule === "unbalanced-syntax" || f.rule === "unknown-sheet" || f.rule === "unknown-function",
			)
			if (hard.length > 0) {
				throw new DocumentError(
					"corrupt",
					`formula-lint rejected ${cell} on sheet "${sheet.name}": ${hard.map((f) => `[${f.rule}] ${f.message}`).join("; ")}`,
					"xlsx",
				)
			}
			for (const f of findings) {
				if (f.rule === "out-of-range-ref" || f.rule === "spill-function" || f.rule === "missing-xlfn") {
					if (f.rule !== "missing-xlfn") warnings.push(`${sheet.name}!${cell} (${f.rule}): ${f.message}`)
				}
			}
		}
		const { xml } = sheetXml(sheet, styles, i, shapes[i], lint)
		return xml
	})

	const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${spec.sheets
		.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
		.join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`

	const zip = new JSZip()
	const date = clock.now()
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${spec.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`,
		{ date },
	)
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rIdMeta" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`,
		{ date },
	)
	zip.file(
		"docProps/core.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>kimchi</dc:creator>${spec.title ? `<dc:title>${esc(spec.title)}</dc:title>` : ""}
<dcterms:created xsi:type="dcterms:W3CDTF">${date.toISOString()}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${date.toISOString()}</dcterms:modified>
</cp:coreProperties>`,
		{ date },
	)
	zip.file(
		"xl/_rels/workbook.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${spec.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
		{ date },
	)
	zip.file("xl/workbook.xml", workbookXml, { date })
	zip.file("xl/styles.xml", styles.stylesXml, { date })
	for (const [i, xml] of parts.entries()) zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml, { date })

	const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
	return { bytes, warnings, formulas }
}
