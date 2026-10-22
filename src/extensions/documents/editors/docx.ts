/**
 * Transactional DOCX editor — surgical edits on the OOXML package. The
 * document.xml string is scanned into body-block spans (extractors/docx.ts)
 * and only the affected blocks change; every other byte of every part is
 * carried through. Contents already tracked (`w:ins`/`w:del`) are never
 * treated as editable text and are preserved untouched.
 *
 * Ops (matches the docx skill's ops reference):
 *   replace-text   unique anchor (pi edit semantics) or --all; run-aware:
 *                  first run's formatting wins, xml:space preserved
 *   insert-after / insert-before  anchor → new content from Markdown
 *   delete         the paragraph(s) containing a unique anchor
 *   append         Markdown content at the end of the document
 *   set-table-cell table N, row R, column C
 *   add-comment    wrap the anchor's paragraph in a comment range + part
 *
 * Insert/append Markdown support is deliberately narrow in v1: paragraphs,
 * headings (via the target's existing styles), bold/italic/code, links
 * (rendered as text with the URL appended) and simple lists (rendered as
 * bullet-marked paragraphs). Images and tables are rejected with guidance.
 */

import type { Element as XmlElement } from "@xmldom/xmldom"
import { XMLSerializer } from "@xmldom/xmldom"
import { scanBlocks, stripTags } from "../extractors/docx.js"
import { type Block, type Inline, parseMarkdownBlocks } from "../markdown/blocks.js"
import { DocumentError } from "../model.js"
import type { OoxmlPackage } from "../ooxml/package.js"
import { byTag, childElements, parseXml, setTextPreservingSpace } from "../ooxml/xml.js"

export type DocxOp =
	| { type: "replace-text"; anchor: string; value: string; all?: boolean }
	| { type: "insert-after"; anchor: string; value: string }
	| { type: "insert-before"; anchor: string; value: string }
	| { type: "delete"; anchor: string }
	| { type: "append"; value: string }
	| { type: "set-table-cell"; table: number; row: number; column: number; value: string }
	| { type: "add-comment"; anchor: string; value: string; author: string }

export function parseDocxOps(raw: unknown): DocxOp[] {
	if (!Array.isArray(raw)) {
		throw new DocumentError("corrupt", "ops must be a JSON array of op objects", "docx")
	}
	return raw.map((item, i) => {
		const bad = (msg: string) => new DocumentError("corrupt", `op ${i + 1}: ${msg}`, "docx")
		if (typeof item !== "object" || item === null || Array.isArray(item)) throw bad("op must be a JSON object")
		const o = item as Record<string, unknown>
		const reqStr = (k: string) => {
			const v = o[k]
			if (typeof v !== "string") throw bad(`missing or non-string "${k}"`)
			return v
		}
		const reqNum = (k: string) => {
			const v = o[k]
			if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw bad(`missing or invalid "${k}" (1-based)`)
			return v
		}
		switch (o.type) {
			case "replace-text":
				return { type: "replace-text", anchor: reqStr("anchor"), value: reqStr("value"), all: o.all === true }
			case "insert-after":
				return { type: "insert-after", anchor: reqStr("anchor"), value: reqStr("value") }
			case "insert-before":
				return { type: "insert-before", anchor: reqStr("anchor"), value: reqStr("value") }
			case "delete":
				return { type: "delete", anchor: reqStr("anchor") }
			case "append":
				return { type: "append", value: reqStr("value") }
			case "set-table-cell":
				return {
					type: "set-table-cell",
					table: reqNum("table"),
					row: reqNum("row"),
					column: reqNum("column"),
					value: reqStr("value"),
				}
			case "add-comment":
				return { type: "add-comment", anchor: reqStr("anchor"), value: reqStr("value"), author: reqStr("author") }
			default:
				throw bad(
					`unknown op "${String(o.type)}" — supported: replace-text, insert-after, insert-before, delete, append, set-table-cell, add-comment`,
				)
		}
	})
}

// --- XML building for inserted content ---------------------------------------

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }
function escXml(s: string): string {
	return s.replace(/[&<>"]/g, (c) => XML_ESCAPES[c])
}

/** Any inline image markers anywhere in the blocks? */
function hasInlineImage(blocks: Block[]): boolean {
	for (const b of blocks) {
		if ((b.type === "paragraph" || b.type === "heading") && b.inline.some((i) => i.image)) return true
		if (b.type === "list" && b.items.some((item) => hasInlineImage(item))) return true
		if (b.type === "blockquote" && hasInlineImage(b.blocks)) return true
	}
	return false
}

function inlineToRunXml(inline: Inline[]): string {
	const runs: string[] = []
	for (const i of inline) {
		const props: string[] = []
		if (i.bold) props.push("<w:b/>")
		if (i.italic) props.push("<w:i/>")
		if (i.code) props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>')
		const rPr = props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : ""
		let hrefNote = ""
		const text = i.text
		if (i.href && !i.image) hrefNote = ` (${i.href})`
		const full = text + hrefNote
		const space = /^\s|\s$/.test(full) ? ' xml:space="preserve"' : ""
		for (const [idx, piece] of full.split("\n").entries()) {
			runs.push(`<w:r>${rPr}${idx > 0 ? "<w:br/>" : ""}<w:t${space}>${escXml(piece)}</w:t></w:r>`)
		}
	}
	return runs.join("")
}

/** Narrow Markdown → body-block XML fragments (see file header for scope). */
export function markdownToBodyXml(markdown: string): string {
	const blocks = parseMarkdownBlocks(markdown)
	for (const b of blocks) {
		if (b.type === "image" || hasInlineImage(blocks)) {
			throw new DocumentError(
				"corrupt",
				"insert/append does not support images in v1 — create a new document or add images separately",
				"docx",
			)
		}
		if (b.type === "table") {
			throw new DocumentError(
				"corrupt",
				"insert/append does not support tables in v1 — create a new document, or set-table-cell on an existing table",
				"docx",
			)
		}
		if (b.type === "chart") throw new DocumentError("corrupt", "charts are not supported in DOCX", "docx")
	}
	const pieces: string[] = []
	const emit = (block: Block, indent: number) => {
		switch (block.type) {
			case "heading":
				pieces.push(
					`<w:p><w:pPr><w:pStyle w:val="Heading${block.level}"/></w:pPr>${inlineToRunXml(block.inline)}</w:p>`,
				)
				break
			case "paragraph":
				pieces.push(`<w:p>${inlineToRunXml(block.inline)}</w:p>`)
				break
			case "list":
				for (const item of block.items) {
					for (const child of item) {
						if (child.type === "list") {
							emit(child, indent + 1)
						} else if (child.type === "paragraph") {
							const marker = block.ordered ? "1." : "-"
							const pad = "  ".repeat(indent)
							pieces.push(`<w:p>${inlineToRunXml([{ text: `${pad}${marker} ` }, ...child.inline])}</w:p>`)
						}
					}
				}
				break
			case "blockquote":
				for (const inner of block.blocks) emit(inner, indent + 1)
				break
			case "code": {
				for (const line of block.code.split("\n")) {
					const space = /^\s|\s$/.test(line) ? ' xml:space="preserve"' : ""
					pieces.push(
						`<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr><w:t${space}>${escXml(line)}</w:t></w:r></w:p>`,
					)
				}
				break
			}
			case "pagebreak":
				pieces.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
				break
			default:
				break
		}
	}
	for (const b of blocks) emit(b, 0)
	return pieces.join("\n")
}

// --- Fragment DOM helpers ------------------------------------------------------

/**
 * Parse a body-block fragment with namespace declarations injected (the raw
 * fragment relies on the document root's xmlns declarations). The wrapper is
 * stripped again when serializing back.
 */
function parseFragment(fragment: string): ReturnType<typeof parseXml> {
	return parseXml(
		`<w:body xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${fragment}</w:body>`,
	)
}

/** Serialize the wrapper's children back to the original fragment shape. */
function serializeFragment(dom: ReturnType<typeof parseXml>): string {
	const ser = new XMLSerializer()
	const root = dom.documentElement
	if (!root) return ""
	let out = ""
	for (let i = 0; i < root.childNodes.length; i++) {
		const node = root.childNodes.item(i)
		if (node) out += ser.serializeToString(node)
	}
	// xmldom hoists the wrapper's xmlns declarations onto its children;
	// strip the ones we injected so the document keeps its original shape.
	return out
		.replaceAll(' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', "")
		.replaceAll(' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"', "")
		.replaceAll(' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"', "")
}

// --- Paragraph-level text surgery ---------------------------------------------

/** Visible w:t nodes of one paragraph element, skipping tracked deletions. */
function visibleTextNodes(p: XmlElement): XmlElement[] {
	const out: XmlElement[] = []
	const walk = (el: XmlElement, skip: boolean) => {
		const tag = el.tagName
		const nextSkip = skip || tag === "w:del" || tag === "w:delText"
		if (!nextSkip && tag === "w:t") out.push(el)
		for (const child of childElements(el)) walk(child, nextSkip)
	}
	walk(p, false)
	return out
}

/** Replace the first occurrence of anchor across a paragraph's visible
 *  runs; first matched run's formatting wins. Returns true when applied. */
function replaceAcrossRuns(p: XmlElement, anchor: string, value: string): boolean {
	const nodes = visibleTextNodes(p)
	const joined = nodes.map((n) => n.textContent ?? "").join("")
	const at = joined.indexOf(anchor)
	if (at < 0) return false
	const aEnd = at + anchor.length
	// Rewrite runs by ORIGINAL text spans so untouched regions round-trip.
	let pos = 0
	for (const node of nodes) {
		const text = node.textContent ?? ""
		const s = pos
		const e = pos + text.length
		pos = e
		if (e <= at || s >= aEnd) continue // outside the match
		const pre = text.slice(0, Math.max(0, Math.min(at - s, text.length)))
		const post = text.slice(Math.min(Math.max(0, aEnd - s), text.length))
		if (s <= at) {
			setTextPreservingSpace(node, pre + value + post)
		} else {
			node.textContent = post
		}
	}
	return true
}

// --- Main apply loop -----------------------------------------------------------

export interface ApplyDocxOpsResult {
	applied: string[]
	trackedChangesPresent: boolean
	commentsAdded: number
}

/**
 * Apply ops to the package's word/document.xml. Anchors resolve against the
 * CURRENT document after each op (positions shift when content is inserted).
 * Throws a typed DocumentError on the first failing op; callers must not
 * save partial output.
 */
export function applyDocxOps(pkg: OoxmlPackage, ops: DocxOp[]): ApplyDocxOpsResult {
	const raw = pkg.getBytes("word/document.xml")
	if (!raw) throw new DocumentError("corrupt", "Missing word/document.xml", "docx")
	let documentXml = new TextDecoder().decode(raw)
	const trackedChangesPresent = /<w:(ins|del)\b/.test(documentXml)
	const result: ApplyDocxOpsResult = { applied: [], trackedChangesPresent, commentsAdded: 0 }

	const bodyOpen = (xml: string) => {
		const m = /<w:body\b[^>]*>/.exec(xml)
		if (!m) throw new DocumentError("corrupt", "Missing w:body in word/document.xml", "docx")
		return m
	}

	/** Re-scan after each mutation. */
	const currentSpans = () => scanBlocks(documentXml)

	/** Paragraph text (visible) keyed by block index, skipping tables. */
	const paragraphTexts = (spans: ReturnType<typeof scanBlocks>) =>
		spans.map((s) =>
			s.kind === "p" ? stripTags(documentXml.slice(s.start, s.end)).replace(/\s+/g, " ").trim() : undefined,
		)

	const findAnchorBlocks = (anchor: string): { indices: number[]; inTable: boolean } => {
		const spans = currentSpans()
		const texts = paragraphTexts(spans)
		const indices: number[] = []
		for (const [i, t] of texts.entries()) {
			if (t !== undefined && t.includes(anchor)) indices.push(i)
		}
		let inTable = false
		if (indices.length === 0) {
			// Anchor may live in a table; report rather than pretend it's absent.
			for (const [i, s] of spans.entries()) {
				if (s.kind === "tbl" && stripTags(documentXml.slice(s.start, s.end)).includes(anchor)) {
					inTable = true
					indices.push(i)
					break
				}
			}
		}
		return { indices, inTable }
	}

	const requireUniqueAnchor = (anchor: string, what: string) => {
		const { indices, inTable } = findAnchorBlocks(anchor)
		if (indices.length === 0) {
			throw new DocumentError(
				"corrupt",
				`${what}: anchor not found: ${JSON.stringify(anchor.slice(0, 80))} — check exact quoting against read output`,
				"docx",
			)
		}
		if (indices.length > 1) {
			throw new DocumentError(
				"corrupt",
				`${what}: anchor matches ${indices.length} paragraphs (blocks ${indices.map((i) => i + 1).join(", ")}) — use a longer, unique snippet`,
				"docx",
			)
		}
		if (inTable) {
			throw new DocumentError(
				"corrupt",
				`${what}: anchor is inside a table cell (block ${indices[0] + 1}) — use set-table-cell`,
				"docx",
			)
		}
		return indices[0]
	}

	/** Replace a body-block span with new XML and re-assign documentXml. */
	const replaceSpan = (span: { start: number; end: number }, replacement: string) => {
		documentXml = documentXml.slice(0, span.start) + replacement + documentXml.slice(span.end)
	}

	for (const [oi, op] of ops.entries()) {
		const label = `op ${oi + 1} (${op.type})`
		switch (op.type) {
			case "replace-text": {
				const occurrences = op.all ? findAnchorBlocks(op.anchor).indices : [requireUniqueAnchor(op.anchor, label)]
				if (occurrences.length === 0 && op.all) {
					throw new DocumentError(
						"corrupt",
						`${label}: anchor not found: ${JSON.stringify(op.anchor.slice(0, 80))}`,
						"docx",
					)
				}
				let count = 0
				for (const blockIndex of [...occurrences].sort((a, b) => b - a)) {
					const span = currentSpans()[blockIndex]
					if (!span || span.kind !== "p") {
						throw new DocumentError("corrupt", `${label}: block ${blockIndex + 1} is not a paragraph`, "docx")
					}
					const fragment = documentXml.slice(span.start, span.end)
					const dom = parseFragment(fragment)
					if (!replaceAcrossRuns(dom.documentElement as XmlElement, op.anchor, op.value)) {
						throw new DocumentError(
							"corrupt",
							`${label}: anchor spans paragraph markup in block ${blockIndex + 1} — narrow the snippet to visible text`,
							"docx",
						)
					}
					replaceSpan(span, serializeFragment(dom))
					count++
				}
				result.applied.push(`${label}: replaced in ${count} paragraph(s)`)
				break
			}
			case "delete": {
				const blockIndex = requireUniqueAnchor(op.anchor, label)
				const span = currentSpans()[blockIndex]
				replaceSpan(span, "")
				result.applied.push(`${label}: deleted block ${blockIndex + 1}`)
				break
			}
			case "insert-after":
			case "insert-before": {
				const blockIndex = requireUniqueAnchor(op.anchor, label)
				const span = currentSpans()[blockIndex]
				const xml = markdownToBodyXml(op.value)
				if (xml.trim()) {
					if (op.type === "insert-before") {
						documentXml = documentXml.slice(0, span.start) + xml + "\n" + documentXml.slice(span.start)
					} else {
						documentXml = documentXml.slice(0, span.end) + "\n" + xml + documentXml.slice(span.end)
					}
				}
				result.applied.push(
					`${label}: inserted content ${op.type === "insert-before" ? "before" : "after"} block ${blockIndex + 1}`,
				)
				break
			}
			case "append": {
				const xml = markdownToBodyXml(op.value)
				const open = bodyOpen(documentXml)
				const bodyClose = documentXml.indexOf("</w:body>", open.index)
				if (bodyClose < 0) throw new DocumentError("corrupt", "Unclosed w:body", "docx")
				// Insert before the final sectPr if one exists, else before w:body end.
				const sect = documentXml.lastIndexOf("<w:sectPr", bodyClose)
				const insertAt = sect > open.index ? sect : bodyClose
				documentXml = documentXml.slice(0, insertAt) + xml + "\n" + documentXml.slice(insertAt)
				result.applied.push(`${label}: appended at the end of the document`)
				break
			}
			case "set-table-cell": {
				const spans = currentSpans()
				const tables = spans.filter((s) => s.kind === "tbl")
				const span = tables[op.table - 1]
				if (!span) {
					throw new DocumentError("corrupt", `${label}: no table ${op.table} (document has ${tables.length})`, "docx")
				}
				const dom = parseFragment(documentXml.slice(span.start, span.end))
				const rows = byTag(dom, "tr")
				const row = rows[op.row - 1]
				if (!row) {
					throw new DocumentError(
						"corrupt",
						`${label}: table ${op.table} has ${rows.length} rows, no row ${op.row}`,
						"docx",
					)
				}
				const cells = childElements(row).filter((c) => c.tagName === "w:tc")
				const cell = cells[op.column - 1]
				if (!cell) {
					throw new DocumentError(
						"corrupt",
						`${label}: row ${op.row} of table ${op.table} has ${cells.length} cells, no column ${op.column}`,
						"docx",
					)
				}
				// Keep the first paragraph (and its first run's properties); drop the rest.
				if (byTag(cell, "p").length === 0) {
					cell.appendChild(dom.createElement("w:p"))
				}
				const keep = byTag(cell, "p")[0]
				for (const extra of byTag(cell, "p").slice(1)) cell.removeChild(extra)
				for (const child of childElements(keep)) keep.removeChild(child)
				const run = dom.createElement("w:r")
				const t = dom.createElement("w:t")
				setTextPreservingSpace(t as XmlElement, op.value)
				run.appendChild(t)
				keep.appendChild(run)
				replaceSpan(span, serializeFragment(dom))
				result.applied.push(`${label}: set table ${op.table} row ${op.row} column ${op.column}`)
				break
			}
			case "add-comment": {
				const blockIndex = requireUniqueAnchor(op.anchor, label)
				const span = currentSpans()[blockIndex]
				const id = nextCommentId(pkg)
				// Wrap the whole paragraph in a comment range and append the reference.
				const fragment = documentXml.slice(span.start, span.end)
				const openMatch = /^<w:p\b[^>]*>/.exec(fragment)
				const closeIdx = fragment.lastIndexOf("</w:p>")
				if (!openMatch || closeIdx < 0)
					throw new DocumentError("corrupt", `${label}: cannot anchor a comment here`, "docx")
				// Range markers must sit INSIDE the paragraph so the extractor
				// (and Word) associates the comment with this paragraph.
				const wrapped =
					`${openMatch[0]}<w:commentRangeStart w:id="${id}"/>` +
					fragment.slice(openMatch[0].length, closeIdx) +
					`<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>` +
					fragment.slice(closeIdx)
				replaceSpan(span, wrapped)
				appendCommentPart(pkg, id, op.author, op.value)
				result.commentsAdded++
				result.applied.push(`${label}: added comment ${id} on block ${blockIndex + 1}`)
				break
			}
		}
	}

	pkg.putBytes("word/document.xml", new TextEncoder().encode(documentXml))
	return result
}

// --- Comment parts -------------------------------------------------------------

function nextCommentId(pkg: OoxmlPackage): number {
	if (!pkg.hasXml("word/comments.xml")) return 0
	const doc = pkg.getXml("word/comments.xml")
	let max = -1
	for (const c of byTag(doc, "comment")) {
		const id = Number(c.getAttribute("w:id") ?? -1)
		if (id > max) max = id
	}
	return max + 1
}

function appendCommentPart(pkg: OoxmlPackage, id: number, author: string, text: string): void {
	const commentXml = `<w:comment w:id="${id}" w:author="${escXml(author)}"><w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr><w:r><w:t xml:space="preserve">${escXml(text)}</w:t></w:r></w:p></w:comment>`
	let commentsXml: string
	if (pkg.hasXml("word/comments.xml")) {
		const bytes = pkg.getBytes("word/comments.xml")
		const existing = new TextDecoder().decode(bytes)
		const close = existing.lastIndexOf("</w:comments>")
		if (close < 0) throw new DocumentError("corrupt", "Malformed word/comments.xml", "docx")
		commentsXml = existing.slice(0, close) + commentXml + existing.slice(close)
	} else {
		commentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${commentXml}</w:comments>`
		// Register the part: [Content_Types] override + document.xml.rels entry.
		ensureContentTypeOverride(
			pkg,
			"/word/comments.xml",
			"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
		)
		ensureDocumentRel(
			pkg,
			"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
			"comments.xml",
		)
	}
	pkg.putBytes("word/comments.xml", new TextEncoder().encode(commentsXml))
}

function ensureContentTypeOverride(pkg: OoxmlPackage, partName: string, contentType: string): void {
	const bytes = pkg.getBytes("[Content_Types].xml")
	if (!bytes) throw new DocumentError("corrupt", "Missing [Content_Types].xml", "docx")
	const xml = new TextDecoder().decode(bytes)
	if (xml.includes(`PartName="${partName}"`)) return
	const close = xml.lastIndexOf("</Types>")
	pkg.putBytes(
		"[Content_Types].xml",
		new TextEncoder().encode(
			xml.slice(0, close) + `<Override PartName="${partName}" ContentType="${contentType}"/>` + xml.slice(close),
		),
	)
}

function ensureDocumentRel(pkg: OoxmlPackage, type: string, target: string): void {
	const relsName = "word/_rels/document.xml.rels"
	const relsXml = pkg.hasXml(relsName)
		? new TextDecoder().decode(pkg.getBytes(relsName))
		: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
	if (relsXml.includes(`Target="${target}"`)) return
	let maxId = 0
	for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) maxId = Math.max(maxId, Number(m[1]))
	const id = `rId${(maxId || 0) + 1}`
	const close = relsXml.lastIndexOf("</Relationships>")
	pkg.putBytes(
		relsName,
		new TextEncoder().encode(
			relsXml.slice(0, close) + `<Relationship Id="${id}" Type="${type}" Target="${target}"/>` + relsXml.slice(close),
		),
	)
}
