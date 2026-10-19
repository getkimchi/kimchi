/**
 * Transactional PPTX editor. EVERY op mutates one in-memory OoxmlPackage; a
 * typed DocumentError at any op aborts the edit (callers never write partial
 * output). Shape identity uses the exact `pptx.mjs inspect` vocabulary:
 * `[shape "..."]` names, `[table N]` indices, 1-based slide numbers.
 *
 * Formatting inheritance (`set_shape_text`, `set_table_cell`): each new
 * paragraph clones the LAST existing paragraph of the shape, so bullets,
 * indent, and the last run's character styling are inherited. Shapes with no
 * runs fall back to a bare run (plain formatting).
 */
import type { Element, Document as XmlDocument } from "@xmldom/xmldom"
import { joinOoxmlPart, ooxmlRelsPath, parseOoxmlRels } from "../extractors/pptx.js"
import { DocumentError } from "../model.js"
import type { OoxmlPackage } from "../ooxml/package.js"
import { byTag, childElements } from "../ooxml/xml.js"
import type { SlideSpec } from "../writers/pptx-model.js"
import { appendSlides, listTemplateLayouts } from "../writers/template.js"

export type DeckProperty = "title" | "subject" | "author" | "keywords" | "comments"

/** Ops the edit flow accepts (matches the skill's ops reference). */
export type PptxOp =
	| { type: "set_shape_text"; slide: number; shape: string; value: string }
	| { type: "set_shape_notes"; slide: number; value: string }
	| { type: "set_table_cell"; slide: number; table: number; cell: string; value: string }
	| { type: "set_table_row"; slide: number; table: number; row: number; values: string[] }
	| { type: "append_slide"; layout?: string; title?: string }
	| { type: "delete_slide"; index: number }
	| { type: "reorder_slides"; order: number[] }
	| { type: "set_deck_core_property"; name: DeckProperty; value: string }

const DECK_PROPERTIES: DeckProperty[] = ["title", "subject", "author", "keywords", "comments"]

/**
 * Parse the ops JSON (an array of op objects, exact fields from the skill's
 * ops reference) into typed ops. Unknown op names and malformed fields are
 * reported with the exact fix language, never loosely ignored.
 */
export function parsePptxOps(raw: unknown): PptxOp[] {
	if (!Array.isArray(raw)) {
		throw new DocumentError("corrupt", "ops must be a JSON array of op objects", "pptx")
	}
	return raw.map((item, i) => {
		const bad = (msg: string) => new DocumentError("corrupt", `op ${i + 1}: ${msg}`, "pptx")
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw bad("op must be a JSON object")
		const o = item as Record<string, unknown>
		const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined)
		const num = (k: string) => (typeof o[k] === "number" && Number.isInteger(o[k]) ? (o[k] as number) : undefined)
		const reqStr = (k: string) => {
			const v = str(k)
			if (v === undefined) throw bad(`missing or non-string "${k}"`)
			return v
		}
		const reqSlide = () => {
			const v = num("slide")
			if (v === undefined || v < 1) throw bad('missing or invalid "slide" (1-based slide number)')
			return v
		}
		switch (o.type) {
			case "set_shape_text":
				return { type: "set_shape_text", slide: reqSlide(), shape: reqStr("shape"), value: reqStr("value") }
			case "set_shape_notes":
				return { type: "set_shape_notes", slide: reqSlide(), value: reqStr("value") }
			case "set_table_cell":
				return {
					type: "set_table_cell",
					slide: reqSlide(),
					table: reqNum(o, "table", bad),
					cell: reqStr("cell"),
					value: reqStr("value"),
				}
			case "set_table_row": {
				const values = o.values
				if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
					throw bad('"values" must be an array of strings (exactly one per column)')
				}
				const row = num("row")
				if (row === undefined || row < 1) throw bad('missing or invalid "row" (1-based row number)')
				return {
					type: "set_table_row",
					slide: reqSlide(),
					table: reqNum(o, "table", bad),
					row,
					values: values as string[],
				}
			}
			case "append_slide": {
				const layout = str("layout")
				const title = str("title")
				return { type: "append_slide", layout, title }
			}
			case "delete_slide": {
				const index = num("index")
				if (index === undefined || index < 1) throw bad('missing or invalid "index" (1-based slide number)')
				return { type: "delete_slide", index }
			}
			case "reorder_slides": {
				const order = o.order
				if (!Array.isArray(order) || order.some((v) => typeof v !== "number")) {
					throw bad('"order" must be an array of 1-based slide numbers, e.g. [2, 1, 3]')
				}
				return { type: "reorder_slides", order: order as number[] }
			}
			case "set_deck_core_property": {
				const name = str("name")
				if (!name || !DECK_PROPERTIES.includes(name as DeckProperty)) {
					throw bad(`"name" must be one of ${DECK_PROPERTIES.map((p) => `"${p}"`).join(", ")}`)
				}
				return { type: "set_deck_core_property", name: name as DeckProperty, value: reqStr("value") }
			}
			default:
				throw bad(
					`unknown op "${String(o.type)}" — supported: set_shape_text, set_shape_notes, set_table_cell, set_table_row, append_slide, delete_slide, reorder_slides, set_deck_core_property`,
				)
		}
	})
}

function reqNum(o: Record<string, unknown>, key: string, bad: (msg: string) => Error): number {
	const v = o[key]
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
		throw bad(`missing or invalid "${key}" (1-based ${key} number)`)
	}
	return v
}

/** Apply every op in order to `pkg`; throws on the first failure. */
export function applyPptxOps(pkg: OoxmlPackage, ops: PptxOp[]): void {
	// Slide indices resolve against the CURRENT order — structural ops
	// (append/delete/reorder) renumber subsequent slides, so resolve lazily
	// per op rather than once up front.
	const at = (slide: number) => slidePath(slidePartOrder(pkg), slide)
	for (const op of ops) {
		switch (op.type) {
			case "set_shape_text":
				setShapeText(pkg, at(op.slide), op.shape, op.value)
				break
			case "set_shape_notes":
				setShapeNotes(pkg, at(op.slide), op.value)
				break
			case "set_table_cell": {
				const [col, row] = parseCellRef(op.cell)
				setTableCell(pkg, at(op.slide), op.table, col, row, op.value)
				break
			}
			case "set_table_row":
				setTableRow(pkg, at(op.slide), op.table, op.row, op.values)
				break
			case "append_slide":
				appendSlide(pkg, op.layout, op.title)
				break
			case "delete_slide":
				deleteSlide(pkg, slidePartOrder(pkg), op.index)
				break
			case "reorder_slides":
				reorderSlides(pkg, op.order)
				break
			case "set_deck_core_property":
				setCoreProperty(pkg, op.name, op.value)
				break
		}
	}
}

// --- package plumbing ---------------------------------------------------------

/** Ordered slide part paths, resolved through presentation rels. */
function slidePartOrder(pkg: OoxmlPackage): string[] {
	const presPath = "ppt/presentation.xml"
	const order = byTag(pkg.getXml(presPath), "sldId")
		.map((el) => el.getAttribute("r:id"))
		.filter((rid): rid is string => Boolean(rid))
	const rels = parseOoxmlRels(pkg.getXml(ooxmlRelsPath(presPath)))
	return order.map((rid) => joinOoxmlPart("ppt", rels[rid] ?? ""))
}

/** 1-based slide number → part path, with a tight hint on range errors. */
function slidePath(slides: string[], slide: number): string {
	const path = slides[slide - 1]
	if (!path) {
		throw new DocumentError(
			"corrupt",
			`slide ${slide} is out of range (deck has ${slides.length} slide${slides.length === 1 ? "" : "s"})`,
			"pptx",
		)
	}
	return path
}

// --- text-body rebuilding -----------------------------------------------------

function findSpByName(doc: XmlDocument, name: string): Element {
	const known: string[] = []
	for (const sp of byTag(doc, "sp")) {
		if (byTag(sp, "cNvPr").some((el) => el.getAttribute("name") === name)) return sp
		const nv = childElements(sp)[0]
		const cn = nv ? childElements(nv)[0] : undefined
		const n = cn?.getAttribute("name")
		if (n) known.push(n)
	}
	throw new DocumentError(
		"corrupt",
		`no shape named "${name}" (here: ${known.map((n) => `“${n}”`).join(", ") || "none"}); run \`inspect\` for exact names`,
		"pptx",
	)
}

function spTxBody(sp: Element): Element {
	for (const child of childElements(sp)) {
		if (child.localName === "txBody") return child
	}
	throw new DocumentError("corrupt", "shape has no text body to edit", "pptx")
}

/**
 * Rebuild a txBody from plain-text lines. Each resulting paragraph clones the
 * LAST template paragraph (namespace-qualified), keeping pPr; each carries a
 * single `<a:r>` stamped with the last-run `rPr` found in the body (formatting
 * inheritance). bodyPr and lstStyle stay untouched.
 */
export function rebuildTxBody(txBody: Element, value: string): void {
	const paragraphs = childElements(txBody).filter((el) => el.localName === "p")
	const template = paragraphs[paragraphs.length - 1]
	const doc = txBody.ownerDocument
	if (!template || !doc) throw new DocumentError("corrupt", "shape's text body has no paragraphs", "pptx")

	let rPrTemplate: Element | undefined
	for (const p of paragraphs) {
		for (const child of childElements(p)) {
			if (child.localName !== "r") continue
			for (const inner of childElements(child)) {
				if (inner.localName === "rPr") rPrTemplate = inner
			}
		}
	}

	const aPrefix = template.prefix ?? "a"
	const aNs = template.namespaceURI ?? "http://schemas.openxmlformats.org/drawingml/2006/main"
	for (const p of paragraphs) txBody.removeChild(p)
	for (const line of value.split("\n")) {
		const np = doc.createElementNS(aNs, `${aPrefix}:p`)
		for (const child of childElements(template)) {
			if (child.localName === "pPr" || child.localName === "endParaRPr") {
				np.appendChild(child.cloneNode(true))
			}
		}
		const r = doc.createElementNS(aNs, `${aPrefix}:r`)
		if (rPrTemplate) r.appendChild(rPrTemplate.cloneNode(true))
		const t = doc.createElementNS(aNs, `${aPrefix}:t`)
		t.appendChild(doc.createTextNode(line))
		r.appendChild(t)
		np.appendChild(r)
		txBody.appendChild(np)
	}
}

// --- ops ----------------------------------------------------------------------

function setShapeText(pkg: OoxmlPackage, path: string, shape: string, value: string): void {
	const doc = pkg.getXml(path)
	rebuildTxBody(spTxBody(findSpByName(doc, shape)), value)
	pkg.putXml(path, doc)
}

function notesPartForSlide(pkg: OoxmlPackage, slidePart: string): string | undefined {
	const relsPath = ooxmlRelsPath(slidePart)
	if (!pkg.hasXml(relsPath)) return undefined
	const rels = parseOoxmlRels(pkg.getXml(relsPath))
	const target = Object.values(rels).find((t) => t.includes("notesSlide"))
	if (!target) return undefined
	const notesPath = target.startsWith("/") ? target.slice(1) : joinOoxmlPart("ppt/slides", target)
	return pkg.hasXml(notesPath) ? notesPath : undefined
}

function setShapeNotes(pkg: OoxmlPackage, slidePart: string, value: string): void {
	const notesPath = notesPartForSlide(pkg, slidePart)
	if (!notesPath) {
		throw new DocumentError(
			"unsupported-format",
			"slide has no notes part — add notes in PowerPoint first, or rebuild the deck with `create --content` (which allocates notes)",
			"pptx",
		)
	}
	const doc = pkg.getXml(notesPath)
	// Edit only the notes BODY placeholder; notes pages also carry the slide
	// image and slide number placeholders. Some decks mark the notes body by
	// position only (no ph) — fall back to the only text-bearing shape.
	const shapes = byTag(doc, "sp")
	let body: Element | undefined
	for (const sp of shapes) {
		for (const ph of byTag(sp, "ph")) {
			if ((ph.getAttribute("type") ?? "body") === "body") body = sp
			break
		}
		if (body) break
	}
	if (!body) body = shapes.find((sp) => childElements(sp).some((el) => el.localName === "txBody"))
	if (!body) throw new DocumentError("corrupt", "notes part has no text shape to edit", "pptx")
	rebuildTxBody(spTxBody(body), value)
	pkg.putXml(notesPath, doc)
}

function slideTbl(doc: XmlDocument, index: number): Element {
	const tbls = byTag(doc, "tbl")
	const tbl = tbls[index - 1]
	if (!tbl) {
		throw new DocumentError(
			"corrupt",
			`slide has ${tbls.length} table${tbls.length === 1 ? "" : "s"}; no [table ${index}] — run \`inspect\` to list indices`,
			"pptx",
		)
	}
	return tbl
}

function tableGrid(tbl: Element): Element[][] {
	const grid: Element[][] = []
	for (const tr of childElements(tbl)) {
		if (tr.localName !== "tr") continue
		grid.push(childElements(tr).filter((el) => el.localName === "tc"))
	}
	return grid
}

/** "B3" → 0-based [col, row]. Ops speak A1-style (1-based). */
export function parseCellRef(ref: string): [number, number] {
	const m = /^([A-Za-z]+)([1-9][0-9]*)$/.exec(ref.trim())
	if (!m) {
		throw new DocumentError("corrupt", `invalid cell reference "${ref}" (expected A1-style, e.g. "B3")`, "pptx")
	}
	let col = 0
	for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
	return [col - 1, Number(m[2]) - 1]
}

export function cellRefName(col: number, row: number): string {
	let letters = ""
	let n = col + 1
	while (n > 0) {
		letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
		n = Math.floor((n - 1) / 26)
	}
	return `${letters}${row + 1}`
}

function tcTxBody(tc: Element): Element {
	for (const child of childElements(tc)) {
		if (child.localName === "txBody") return child
	}
	throw new DocumentError("corrupt", "table cell has no text body", "pptx")
}

function setTableCell(pkg: OoxmlPackage, path: string, index: number, col: number, row: number, value: string): void {
	const doc = pkg.getXml(path)
	const grid = tableGrid(slideTbl(doc, index))
	const cell = grid[row]?.[col]
	if (!cell) {
		const rows = grid.length
		const cols = Math.max(0, ...grid.map((r) => r.length))
		throw new DocumentError(
			"corrupt",
			`cell ${cellRefName(col, row)} is outside the table (${rows} row${rows === 1 ? "" : "s"} x ${cols} column${cols === 1 ? "" : "s"})`,
			"pptx",
		)
	}
	rebuildTxBody(tcTxBody(cell), value)
	pkg.putXml(path, doc)
}

function setTableRow(pkg: OoxmlPackage, path: string, index: number, row: number, values: string[]): void {
	const doc = pkg.getXml(path)
	const grid = tableGrid(slideTbl(doc, index))
	const target = grid[row - 1]
	if (!target) {
		throw new DocumentError("corrupt", `row ${row} is outside the table (${grid.length} rows)`, "pptx")
	}
	if (values.length !== target.length) {
		throw new DocumentError(
			"corrupt",
			`row ${row} has ${target.length} cells but ${values.length} values were given — pass exactly one value per column`,
			"pptx",
		)
	}
	for (let c = 0; c < target.length; c++) rebuildTxBody(tcTxBody(target[c]), values[c])
	pkg.putXml(path, doc)
}

/**
 * Append a slide after the last. Reuses the template machinery: the new
 * slide targets the deck's OWN layouts (by name when `layoutName` is given,
 * structural pick otherwise) and inherits its masters/theme.
 */
function appendSlide(pkg: OoxmlPackage, layoutName: string | undefined, title: string | undefined): void {
	const layouts = listTemplateLayouts(pkg)
	if (layouts.length === 0) {
		throw new DocumentError("corrupt", "deck has no slide layouts — cannot append slides", "pptx")
	}
	// Bare layouts (created decks) carry no placeholders to fill — fall back
	// to the first layout and let the writer's free-form fallback place text.
	const withPlaceholders = layouts.some((l) => l.placeholders.length > 0)
	const spec: SlideSpec = {
		index: 1,
		layoutHint: layoutName || !withPlaceholders ? undefined : "content",
		layoutName: layoutName ?? (withPlaceholders ? undefined : layouts[0].name),
		heading: title,
		elements: [],
		notes: [],
	}
	appendSlides(pkg, [spec], layouts)
}

/** Remove the 1-based slide: drop its sldId, rel, slide part, and notes part. */
function deleteSlide(pkg: OoxmlPackage, slides: string[], index: number): void {
	const path = slidePath(slides, index)
	if (slides.length === 1) {
		throw new DocumentError("corrupt", "cannot delete the only slide — a deck must keep at least one", "pptx")
	}
	const presPath = "ppt/presentation.xml"
	const presRelsPath = ooxmlRelsPath(presPath)
	const rid = byTag(pkg.getXml(presPath), "sldId").map((el) => el.getAttribute("r:id"))[index - 1] ?? ""
	const pres = pkg.getXml(presPath)
	for (const sldId of byTag(pres, "sldId")) {
		if (sldId.getAttribute("r:id") === rid) {
			sldId.parentNode?.removeChild(sldId)
			break
		}
	}
	const relsDoc = pkg.getXml(presRelsPath)
	for (const rel of byTag(relsDoc, "Relationship")) {
		if (rel.getAttribute("Id") === rid) rel.parentNode?.removeChild(rel)
	}
	pkg.putXml(presRelsPath, relsDoc)
	pkg.putXml(presPath, pres)
	const notesPath = notesPartForSlide(pkg, path)
	pkg.remove(path)
	const relsPath = ooxmlRelsPath(path)
	if (pkg.hasXml(relsPath)) pkg.remove(relsPath)
	if (notesPath) {
		pkg.remove(notesPath)
		const notesRels = ooxmlRelsPath(notesPath)
		if (pkg.hasXml(notesRels)) pkg.remove(notesRels)
	}
}

/** order = 1-based slide numbers arranged in their NEW order. */
function reorderSlides(pkg: OoxmlPackage, order: number[]): void {
	const n = slidePartOrder(pkg).length
	const sorted = [...order].sort((a, b) => a - b)
	const permutation = order.length === n && sorted.every((v, i) => v === i + 1)
	if (!permutation) {
		throw new DocumentError("corrupt", `order must be a permutation of 1..${n} (got ${order.join(", ")})`, "pptx")
	}
	const presPath = "ppt/presentation.xml"
	const pres = pkg.getXml(presPath)
	const ids = byTag(pres, "sldId")
	const parent = ids[0]?.parentNode
	if (ids.length !== n || !parent) {
		throw new DocumentError("corrupt", "presentation slide list is corrupt", "pptx")
	}
	const copies = ids.map((el) => el.cloneNode(true))
	for (const id of ids) parent.removeChild(id)
	for (const idx of order) parent.appendChild(copies[idx - 1])
	pkg.putXml(presPath, pres)
}

const CORE_TAGS: Record<DeckProperty, string> = {
	title: "title",
	subject: "subject",
	author: "creator",
	keywords: "keywords",
	comments: "description",
}

function setCoreProperty(pkg: OoxmlPackage, name: DeckProperty, value: string): void {
	const path = "docProps/core.xml"
	if (!pkg.hasXml(path)) throw new DocumentError("unsupported-format", "deck has no docProps/core.xml to edit", "pptx")
	const doc = pkg.getXml(path)
	const matches = byTag(doc, CORE_TAGS[name])
	const el = matches[0]
	if (!el) {
		throw new DocumentError("unsupported-format", `core properties have no ${name} element to update`, "pptx")
	}
	while (el.firstChild) el.removeChild(el.firstChild)
	el.appendChild(doc.createTextNode(value))
	pkg.putXml(path, doc)
}
