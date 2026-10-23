/**
 * XLSX extractor on the shared OOXML layer — windowed by sheet and rows.
 *
 * Same memory stance as the DOCX extractor: worksheet XML is scanned as a
 * string and only the requested rows are DOM-parsed (row fragments).
 * sharedStrings.xml is string-scanned into a flat array (never a full DOM;
 * it is the random-access table every row needs). styles.xml, workbook.xml
 * and rels are small and parse fully; side parts are capped at 20 MB raw.
 *
 * Renders the model.ts sheet units: one unit per requested sheet, Markdown
 * as a pipe table with a leading row-number column and a column-letter
 * header (matches render.ts's XLSX row slicing). Formulas show with their
 * cached values when `showFormulas` is on. Dates convert from serial UTC
 * with the 1900/1904 rule; never toLocaleString (TZ-independent).
 */

import type { Element as XmlElement } from "@xmldom/xmldom"
import { MAX_OUTPUT_CHARS } from "../limits.js"
import { DocumentError } from "../model.js"
import { type OoxmlPackage, openOoxml } from "../ooxml/package.js"
import { byTag, fragmentNamespaces, parseFragment, parseXml } from "../ooxml/xml.js"
import { columnLetter, parseCellRef } from "../xlsx-refs.js"

/**
 * Namespace fallback for row fragments when the worksheet root doesn't
 * declare them itself. Excel 2010+ declares these plus `mc:`, `x14ac:`,
 * `xr:` on `<worksheet>`; a prefix that IS declared on the root wins, so
 * real files parse with their own declarations.
 */
const ROW_FRAGMENT_REQUIRED = [
	{ prefix: "", uri: "http://schemas.openxmlformats.org/spreadsheetml/2006/main" },
	{ prefix: "r", uri: "http://schemas.openxmlformats.org/officeDocument/2006/relationships" },
]

/** Raw cap for parts parsed fully (worksheet + sharedStrings are scanned). */
const SIDE_PART_MAX_BYTES = 20 * 1024 * 1024

export interface SheetInfo {
	name: string
	state: "visible" | "hidden" | "veryHidden"
	part: string
	/** Last row seen (1-based), from the sheet's dimension or scan. */
	lastRow: number
	/** Used column letters max, e.g. "F". */
	lastColumn: string
	rowCount: number
}

export interface XlsxWindow {
	sheet: string
	fromRow: number
	toRow: number
	markdown: string
	truncated: boolean
	merged: string[]
}

export interface XlsxExtraction {
	format: "xlsx" | "csv"
	sheets: SheetInfo[]
	notes: string[]
	info: {
		title?: string
		creator?: string
		date1904: boolean
		hasMacros: boolean
		hasExternalLinks: boolean
	}
	/**
	 * Render a row window of a sheet (1-based, inclusive, clamped).
	 * `showFormulas` renders `=…` with the cached value instead of the value alone.
	 */
	window(opts: {
		sheet?: number | string
		startRow?: number
		endRow?: number
		maxChars?: number
		showFormulas?: boolean
	}): XlsxWindow
	/** Sheet lookup used by the CLI and editor messages. */
	sheetIndex(sheet: number | string): number
}

// --- shared strings --------------------------------------------------------------

/** sharedStrings.xml → plain array by string scan (rich runs = concat of <t>). */
function loadSharedStrings(pkg: OoxmlPackage): string[] {
	const bytes = pkg.getBytes("xl/sharedStrings.xml")
	if (!bytes) return []
	if (bytes.length > SIDE_PART_MAX_BYTES) {
		throw new DocumentError(
			"safety-limit",
			`sharedStrings.xml is ${(bytes.length / 1024 / 1024).toFixed(1)} MB raw — side parts are capped at ${SIDE_PART_MAX_BYTES / 1024 / 1024} MB`,
			"xlsx",
		)
	}
	pkg.remove("xl/sharedStrings.xml")
	const xml = new TextDecoder().decode(bytes)
	const out: string[] = []
	const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g
	for (let m = si.exec(xml); m !== null; m = si.exec(xml)) {
		out.push(unescapeXml(stripAllTags(m[1])))
	}
	return out
}

function stripAllTags(fragment: string): string {
	return fragment.replace(/<[^>]+>/g, "")
}

function unescapeXml(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#38;#60;/g, "&lt;")
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&amp;/g, "&")
}

// --- styles / dates ---------------------------------------------------------------

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 27, 30, 36, 45, 46, 47, 50, 57])
const BUILTIN_DATETIME_FMTS = new Set([22])

export function isDateFormatCode(code: string): boolean {
	// Strip quoted literals, escaped chars and bracketed sections, then look
	// for y/m/d/h/s tokens. "m" alone is ambiguous ONLY when paired with
	// numeric placeholders, per ECMA-376 practice.
	const cleaned = code
		.replace(/"[^"]*"/g, "")
		.replace(/\\./g, "")
		.replace(/\[[^\]]*\]/g, "")
	return /[ymdhs]/i.test(cleaned) || /^m{1,5}$/i.test(cleaned)
}

interface Styles {
	cellXfsNumFmt: number[]
	customFmt: Map<number, string>
}

function loadStyles(pkg: OoxmlPackage): Styles {
	const bytes = pkg.getBytes("xl/styles.xml")
	if (!bytes) return { cellXfsNumFmt: [], customFmt: new Map() }
	if (bytes.length > SIDE_PART_MAX_BYTES) {
		throw new DocumentError("safety-limit", "styles.xml exceeds the side-part cap", "xlsx")
	}
	const doc = parseXml(new TextDecoder().decode(bytes))
	const customFmt = new Map<number, string>()
	for (const nf of byTag(doc, "numFmt")) {
		const id = Number(nf.getAttribute("numFmtId"))
		const code = nf.getAttribute("formatCode")
		if (Number.isFinite(id) && code) customFmt.set(id, code)
	}
	const cellXfsNumFmt: number[] = []
	const cellXfs = byTag(doc, "cellXfs")[0]
	if (cellXfs) {
		for (const xf of byTag(cellXfs, "xf")) {
			cellXfsNumFmt.push(Number(xf.getAttribute("numFmtId") ?? 0))
		}
	}
	return { cellXfsNumFmt, customFmt }
}

function styleDateKind(styles: Styles, styleIndex: number): "date" | "datetime" | undefined {
	const id = styles.cellXfsNumFmt[styleIndex] ?? 0
	if (BUILTIN_DATETIME_FMTS.has(id)) return "datetime"
	if (BUILTIN_DATE_FMTS.has(id)) return "date"
	const code = styles.customFmt.get(id)
	if (!code || !isDateFormatCode(code)) return undefined
	return /[hs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")) && /[ymd]/i.test(code) ? "datetime" : "date"
}

/** Excel serial → ISO date(-time), UTC, honoring the 1904 epoch and the
 *  1900 system's phantom Feb 29. */
export function serialToIso(serial: number, epoch1904: boolean, kind: "date" | "datetime"): string {
	// Excel's 1900 system has a phantom leap day: serial 60 is displayed as
	// 1900-02-29, a date the proleptic calendar lacks. Keep the fiction so
	// values match what the spreadsheet UI shows.
	if (!epoch1904 && serial === 60) return kind === "date" ? "1900-02-29" : "1900-02-29 00:00"
	const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)
	let ms = base + Math.round(serial * 86_400) * 1000
	if (!epoch1904 && serial > 60) ms -= 86_400 * 1000
	const iso = new Date(ms).toISOString()
	return kind === "date" ? iso.slice(0, 10) : iso.replace("T", " ").slice(0, 16)
}

// --- workbook / sheet enumeration ----------------------------------------------------

interface WorkbookSheet {
	name: string
	state: "visible" | "hidden" | "veryHidden"
	relId: string
	part: string
}

function loadSheets(pkg: OoxmlPackage): { sheets: WorkbookSheet[]; epoch1904: boolean } {
	const wbBytes = pkg.getBytes("xl/workbook.xml")
	if (!wbBytes) throw new DocumentError("corrupt", "Missing xl/workbook.xml", "xlsx")
	const wb = parseXml(new TextDecoder().decode(wbBytes))
	const wbPr = byTag(wb, "workbookPr")[0]
	const epoch1904 = wbPr?.getAttribute("date1904") === "1" || wbPr?.getAttribute("date1904") === "true"

	const relsBytes = pkg.getBytes("xl/_rels/workbook.xml.rels")
	if (!relsBytes) throw new DocumentError("corrupt", "Missing xl/_rels/workbook.xml.rels", "xlsx")
	const rels = parseXml(new TextDecoder().decode(relsBytes))
	const targets: Record<string, string> = {}
	for (const r of byTag(rels, "Relationship")) {
		const id = r.getAttribute("Id")
		const target = r.getAttribute("Target")
		if (id && target) targets[id] = target.startsWith("/") ? target.slice(1) : `xl/${target}`
	}

	const sheets: WorkbookSheet[] = []
	for (const s of byTag(wb, "sheets")[0] ? byTag(byTag(wb, "sheets")[0], "sheet") : []) {
		const relId = s.getAttribute("r:id")
		const part = relId ? targets[relId] : undefined
		if (!part || !pkg.hasXml(part)) {
			throw new DocumentError(
				"corrupt",
				`Sheet ${JSON.stringify(s.getAttribute("name"))} points at a missing part`,
				"xlsx",
			)
		}
		const stateAttr = s.getAttribute("state")
		sheets.push({
			name: s.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
			state: stateAttr === "hidden" ? "hidden" : stateAttr === "veryHidden" ? "veryHidden" : "visible",
			relId: relId ?? "",
			part,
		})
	}
	if (sheets.length === 0) throw new DocumentError("corrupt", "Workbook has no sheets", "xlsx")
	return { sheets, epoch1904 }
}

/** Row spans in a sheet's XML string (string scan only) — shared with the editor. */
export function scanRowSpans(sheetXml: string): Array<{ row: number; start: number; end: number }> {
	const out: Array<{ row: number; start: number; end: number }> = []
	const openTag = /<row\s+([^>]*?)(\/?)>/g
	for (let m = openTag.exec(sheetXml); m !== null; m = openTag.exec(sheetXml)) {
		const rowAttr = /\br="(\d+)"/.exec(m[1])
		const row = rowAttr ? Number(rowAttr[1]) : out.length + 1
		if (m[2] === "/") {
			out.push({ row, start: m.index, end: m.index + m[0].length })
			continue
		}
		const close = sheetXml.indexOf("</row>", m.index)
		if (close < 0) throw new DocumentError("corrupt", `Unclosed <row r="${row}">`, "xlsx")
		out.push({ row, start: m.index, end: close + "</row>".length })
		openTag.lastIndex = close + "</row>".length
	}
	return out
}

interface ParsedCell {
	ref: string
	row: number
	column: number
	/** Rendered display string. */
	display: string
}

function parseRow(
	sheetXml: string,
	nsDecls: string,
	span: { start: number; end: number },
	sst: string[],
	styles: Styles,
	epoch1904: boolean,
	showFormulas: boolean,
): ParsedCell[] {
	const dom = parseFragment(sheetXml.slice(span.start, span.end), "worksheet", nsDecls)
	const row = byTag(dom, "row")[0]
	if (!row) return []
	const cells: ParsedCell[] = []
	for (const c of byTag(row, "c")) {
		const ref = c.getAttribute("r")
		if (!ref) continue
		const parsed = parseCellRef(ref)
		if (!parsed) continue
		const t = c.getAttribute("t")
		const s = Number(c.getAttribute("s") ?? 0)
		const f = byTag(c, "f")[0]?.textContent ?? undefined
		const v = byTag(c, "v")[0]?.textContent ?? ""
		let value = v
		if (t === "s") value = sst[Number(v)] ?? `⚠ shared string #${v}?`
		else if (t === "b") value = v === "1" ? "TRUE" : "FALSE"
		else if (t === "inlineStr") value = stripAllTags(byTag(c, "is")[0] ? serializeInnerText(byTag(c, "is")[0]) : "")
		else if (t === "str") value = v
		else if (t === "e") value = v || "#ERR"
		else if (v !== "" && styleDateKind(styles, s)) {
			value = serialToIso(Number(v), epoch1904, styleDateKind(styles, s)!)
		}
		const display = f ? (showFormulas ? `=${f} → ${value}` : value) : value
		cells.push({ ref, row: parsed.row, column: parsed.column, display })
	}
	return cells
}

export function serializeInnerText(el: XmlElement): string {
	let out = ""
	for (let i = 0; i < el.childNodes.length; i++) {
		const n = el.childNodes.item(i)
		if (n?.nodeType === 3 || n?.nodeType === 4) out += n.nodeValue ?? ""
		else if (n) out += serializeInnerText(n as XmlElement)
	}
	return out
}

function resolveSheetIndex(infos: SheetInfo[], sheet: number | string): number {
	if (typeof sheet === "number") return sheet - 1
	const lower = sheet.toLowerCase()
	const i = infos.findIndex((s) => s.name.toLowerCase() === lower)
	if (i < 0) {
		throw new DocumentError(
			"corrupt",
			`No sheet named ${JSON.stringify(sheet)} — sheets: ${infos.map((s) => s.name).join(", ")}`,
			"xlsx",
		)
	}
	return i
}

// --- public entry ----------------------------------------------------------------------

export async function extractXlsx(data: Uint8Array): Promise<XlsxExtraction> {
	const pkg = await openOoxml(data)
	const { sheets: wbSheets, epoch1904 } = loadSheets(pkg)
	const sst = loadSharedStrings(pkg)
	const styles = loadStyles(pkg)
	const hasMacros = pkg.hasXml("xl/vbaProject.bin")
	const hasExternalLinks = pkg.names().some((n) => /^xl\/externalLinks\/externalLink\d+\.xml$/.test(n))

	const coreBytes = pkg.getBytes("docProps/core.xml")
	let title: string | undefined
	let creator: string | undefined
	if (coreBytes) {
		const core = parseXml(new TextDecoder().decode(coreBytes))
		title = byTag(core, "title")[0]?.textContent || undefined
		creator = byTag(core, "creator")[0]?.textContent || undefined
	}

	// Scan each sheet's row spans once, drop raw bytes afterwards.
	const spansBySheet: Array<Array<{ row: number; start: number; end: number }>> = []
	const sheetXmlBySheet: string[] = []
	const nsDeclsBySheet: string[] = []
	const mergedBySheet: string[][] = []
	const infos: SheetInfo[] = []
	for (const sh of wbSheets) {
		const bytes = pkg.getBytes(sh.part)
		if (!bytes) throw new DocumentError("corrupt", `Missing sheet part ${sh.part}`, "xlsx")
		const xml = new TextDecoder().decode(bytes)
		pkg.remove(sh.part)
		sheetXmlBySheet.push(xml)
		// Namespace declarations every row fragment parses under, derived from
		// the worksheet root (Excel's `x14ac:`/`mc:`/`xr:` set included).
		nsDeclsBySheet.push(fragmentNamespaces(xml, ROW_FRAGMENT_REQUIRED))
		const spans = scanRowSpans(xml)
		spansBySheet.push(spans)
		mergedBySheet.push([...xml.matchAll(/<mergeCell\s+ref="([A-Za-z0-9:]+)"/g)].map((m) => m[1]).sort())
		let lastRow = 0
		let lastCol = 0
		const dim = /<dimension\s+ref="[^"]*?([A-Z]{1,3})(\d+)"/.exec(xml)
		if (dim) {
			lastRow = Number(dim[2])
			const col = parseCellRef(`${dim[1]}1`)
			lastCol = col?.column ?? 0
		}
		const lastSpan = spans[spans.length - 1]
		infos.push({
			name: sh.name,
			state: sh.state,
			part: sh.part,
			lastRow: Math.max(lastRow, lastSpan?.row ?? 0),
			lastColumn: columnLetter(lastCol || 1),
			rowCount: spans.length,
		})
	}

	const notes: string[] = []
	if (hasMacros) notes.push("contains macros (vbaProject.bin) — read-only, preserved untouched by edits")
	if (hasExternalLinks) notes.push("has external links — never recalculated by this skill")
	if (infos.some((s) => s.state !== "visible"))
		notes.push(
			`hidden sheets: ${infos
				.filter((s) => s.state !== "visible")
				.map((s) => s.name)
				.join(", ")}`,
		)
	return {
		format: "xlsx",
		sheets: infos,
		notes,
		info: { title, creator, date1904: epoch1904, hasMacros, hasExternalLinks },
		sheetIndex(sheet: number | string) {
			return resolveSheetIndex(infos, sheet)
		},
		window(opts) {
			const index = resolveSheetIndex(infos, opts.sheet ?? 1)
			const info = infos[index]
			if (!info) {
				throw new DocumentError("corrupt", `No sheet ${opts.sheet} (workbook has ${infos.length} sheets)`, "xlsx")
			}
			const spans = spansBySheet[index]
			const sheetXml = sheetXmlBySheet[index]
			const startRow = Math.max(1, opts.startRow ?? 1)
			const endRow = Math.min(opts.endRow ?? info.lastRow, info.lastRow)
			const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS
			const showFormulas = opts.showFormulas ?? false

			const inWindow = spans.filter((s) => s.row >= startRow && s.row <= endRow)
			const allCells: ParsedCell[] = []
			let maxCol = 0
			for (const span of inWindow) {
				const cells = parseRow(sheetXml, nsDeclsBySheet[index], span, sst, styles, epoch1904, showFormulas)
				for (const c of cells) maxCol = Math.max(maxCol, c.column)
				allCells.push(...cells)
			}
			const byRow = new Map<number, Map<number, string>>()
			for (const c of allCells) {
				let m = byRow.get(c.row)
				if (!m) {
					m = new Map()
					byRow.set(c.row, m)
				}
				m.set(c.column, c.display)
			}

			const header = ["", ...Array.from({ length: maxCol }, (_, i) => columnLetter(i + 1))]
			const lines: string[] = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`]
			let used = 0
			const truncNote = 200
			const rowsPresent = inWindow.map((s) => s.row)
			let toRow = startRow - 1
			for (const rowNum of rowsPresent) {
				const m = byRow.get(rowNum)
				const cells = [String(rowNum)]
				for (let col = 1; col <= maxCol; col++) cells.push(m?.get(col)?.replace(/\|/g, "\\|").replace(/\n/g, " ") ?? "")
				const line = `| ${cells.join(" | ")} |`
				if (used + line.length + 1 + truncNote > maxChars) break
				lines.push(line)
				used += line.length + 1
				toRow = rowNum
			}
			const truncated = rowsPresent.length > 0 && toRow < rowsPresent[rowsPresent.length - 1]
			// Merges intersecting this sheet: report as cell refs (merge ranges).
			const oob = mergedBySheet[index]
			return {
				sheet: info.name,
				fromRow: startRow,
				toRow,
				markdown: lines.join("\n"),
				truncated,
				merged: oob ?? [],
			}
		},
	}
}

/** RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns rows
 *  of string cells; no formula/date semantics — text as-is. */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = []
	let field = ""
	let row: string[] = []
	let inQuotes = false
	let i = 0
	const pushField = () => {
		row.push(field)
		field = ""
	}
	const pushRow = () => {
		pushField()
		rows.push(row)
		row = []
	}
	while (i < text.length) {
		const c = text[i]
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"'
					i++
				} else inQuotes = false
			} else field += c
		} else if (c === '"') inQuotes = true
		else if (c === ",") pushField()
		else if (c === "\r") {
			if (text[i + 1] === "\n") i++
			pushRow()
		} else if (c === "\n") pushRow()
		else field += c
		i++
	}
	if (field !== "" || row.length > 0) pushRow()
	return rows
}

/** Wrap CSV rows into the same extraction shape as an XLSX single sheet. */
export function extractCsv(text: string): XlsxExtraction {
	const rows = parseCsv(text)
	const info: SheetInfo = {
		name: "(csv)",
		state: "visible",
		part: "(text)",
		lastRow: rows.length,
		lastColumn: columnLetter(Math.max(1, ...rows.map((r) => r.length))),
		rowCount: rows.length,
	}
	return {
		format: "csv",
		sheets: [info],
		notes: [],
		info: { date1904: false, hasMacros: false, hasExternalLinks: false },
		sheetIndex() {
			return 0
		},
		window(opts: { startRow?: number; endRow?: number; maxChars?: number } = {}) {
			const startRow = Math.max(1, opts.startRow ?? 1)
			const endRow = Math.min(opts.endRow ?? rows.length, rows.length)
			const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS
			const maxCol = Math.max(1, ...rows.slice(startRow - 1, endRow).map((r) => r.length))
			const header = ["", ...Array.from({ length: maxCol }, (_, i) => columnLetter(i + 1))]
			const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`]
			let used = 0
			let toRow = startRow - 1
			for (let r = startRow; r <= endRow; r++) {
				const line = `| ${[String(r), ...rows[r - 1].map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " "))].join(" | ")} |`
				if (used + line.length + 1 > maxChars) break
				lines.push(line)
				used += line.length + 1
				toRow = r
			}
			return {
				sheet: "(csv)",
				fromRow: startRow,
				toRow,
				markdown: lines.join("\n"),
				truncated: toRow < endRow,
				merged: [],
			}
		},
	}
}
