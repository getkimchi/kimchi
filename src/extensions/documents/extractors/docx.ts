/**
 * DOCX extractor on the shared OOXML layer — windowed by design.
 *
 * A 20 MB .docx inflates to ~80 MB of `word/document.xml`; parsing that into
 * one xmldom DOM peaked at ~4 GB RSS in the chunk-0 spike, so `document.xml`
 * is never DOM-parsed as a whole. Instead the decoded string is scanned for
 * top-level body blocks (`<w:p>`, `<w:tbl>`), and only the blocks in the
 * requested window are parsed — each as a small standalone fragment.
 * Side parts (numbering/styles/comments/footnotes) are small in practice and
 * parse fully; each is individually capped at 20 MB raw as a hostile-input
 * guard.
 *
 * Locators rendered in the Markdown:
 *   - paragraphs: `pN:` line prefixes (N is the 1-based body-block number,
 *     the same numbering the `read <doc> N-M` window uses)
 *   - tables: `[table N]`
 *   - tracked changes and comments: `> [inserted by X]` style annotations
 *   - footnotes: `[^id]` inline, texts listed under a footnotes heading
 */

import type { Document as XmldDocument, Element as XmlElement } from "@xmldom/xmldom"
import { MAX_OUTPUT_CHARS } from "../limits.js"
import { renderMarkdownTable } from "../markdown-table.js"
import { DocumentError } from "../model.js"
import { type OoxmlPackage, openOoxml } from "../ooxml/package.js"
import { byTag, fragmentNamespaces, parseFragment, parseXml } from "../ooxml/xml.js"

/**
 * Namespace fallback for fragments when the document root doesn't declare
 * the prefixes itself. Office documents declare these (and many more) on
 * `<w:document>`; only hostile or non-Office files need the fallback. A
 * prefix that IS declared on the root wins, so real files parse with their
 * own declarations — including Word's `w14:`, `w15:`, `mc:`, `wps:`, …
 */
export const FRAGMENT_REQUIRED = [
	{ prefix: "w", uri: "http://schemas.openxmlformats.org/wordprocessingml/2006/main" },
	{ prefix: "a", uri: "http://schemas.openxmlformats.org/drawingml/2006/main" },
	{ prefix: "r", uri: "http://schemas.openxmlformats.org/officeDocument/2006/relationships" },
]

/** Raw cap for OOXML side parts parsed fully into memory (document.xml and
 *  worksheet parts follow the windowed path instead). */
const SIDE_PART_MAX_BYTES = 20 * 1024 * 1024

export interface DocxWindow {
	/** 1-based first body-block index included. */
	from: number
	/** 1-based last body-block index included. */
	to: number
	markdown: string
	/** True when `maxChars` cut the window short (to < end requested). */
	truncated: boolean
}

export interface DocxExtraction {
	/** Total top-level body blocks (paragraphs + tables). */
	totalBlocks: number
	tables: number
	/** `<a:blip>` count across the whole document (images). */
	images: number
	/** Heading outline lines across the whole document ("pN: ## Title"). */
	outline: string[]
	notes: string[]
	/** Core properties surface for `info`. */
	info: {
		title?: string
		creator?: string
		lastModifiedBy?: string
		trackedChanges: boolean
		comments: number
		footnotes: number
	}
	/** Render body blocks `start..end` (1-based, inclusive, clamped). */
	window(opts?: { start?: number; end?: number; maxChars?: number }): DocxWindow
	/** Full plain-text of the requested block (used by tests and edit anchors). */
	blockText(index: number): string
}

export interface BlockSpan {
	kind: "p" | "tbl"
	start: number
	end: number
}

function decodePart(pkg: OoxmlPackage, name: string): string | undefined {
	const bytes = pkg.getBytes(name)
	if (!bytes) return undefined
	if (bytes.length > SIDE_PART_MAX_BYTES && name !== "word/document.xml") {
		throw new DocumentError(
			"safety-limit",
			`${name} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB raw — side parts are capped at ${SIDE_PART_MAX_BYTES / 1024 / 1024} MB`,
			"docx",
		)
	}
	return new TextDecoder().decode(bytes)
}

/** Scan `document.xml` once: top-level body block spans. String-scanning
 *  only — no DOM, so memory stays flat on huge files. */
export function scanBlocks(documentXml: string): BlockSpan[] {
	const bodyOpen = /<w:body\b[^>]*>/.exec(documentXml)
	if (!bodyOpen) throw new DocumentError("corrupt", "Missing w:body in word/document.xml", "docx")
	const bodyStart = bodyOpen.index + bodyOpen[0].length
	const bodyClose = documentXml.indexOf("</w:body>", bodyStart)
	if (bodyClose < 0) throw new DocumentError("corrupt", "Unclosed w:body in word/document.xml", "docx")

	const spans: BlockSpan[] = []
	const tag = /<\/?(w:(?:p|tbl))\b[^>]*?(\/?)>/g
	tag.lastIndex = bodyStart
	let depth = 0
	let current: BlockSpan | undefined
	for (let m = tag.exec(documentXml); m !== null && m.index < bodyClose; m = tag.exec(documentXml)) {
		const closing = m[0][1] === "/"
		const selfClose = m[2] === "/"
		if (!closing) {
			if (depth === 0) {
				current = { kind: m[1] === "w:tbl" ? "tbl" : "p", start: m.index, end: -1 }
				if (!selfClose) depth = 1
				else {
					current.end = m.index + m[0].length
					spans.push(current)
					current = undefined
				}
			} else {
				depth++
			}
		} else {
			depth--
			if (depth === 0 && current) {
				current.end = m.index + m[0].length
				spans.push(current)
				current = undefined
			}
		}
	}
	if (current) throw new DocumentError("corrupt", `Unclosed <${current.kind}> in word/document.xml`, "docx")
	return spans
}

/** Cheap tag-strip for outline text (no DOM): remove elements, unescape. */
export function stripTags(fragment: string): string {
	return fragment
		.replace(/<w:tab\b[^>]*>/g, "\t")
		.replace(/<w:br\b[^>]*>/g, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&")
}

type NumberingMap = Record<string, Record<number, "bullet" | "decimal">>

function loadNumbering(pkg: OoxmlPackage): NumberingMap {
	const src = decodePart(pkg, "word/numbering.xml")
	if (!src) return {}
	const doc = parseXml(src)
	const abstract: Record<string, Record<number, "bullet" | "decimal">> = {}
	for (const a of byTag(doc, "abstractNum")) {
		const id = a.getAttribute("w:abstractNumId") ?? a.getAttribute("abstractNumId")
		if (id == null) continue
		const lvls: Record<number, "bullet" | "decimal"> = {}
		for (const lvl of byTag(a, "lvl")) {
			const ilvl = Number(lvl.getAttribute("w:ilvl") ?? lvl.getAttribute("ilvl") ?? 0)
			const fmt = byTag(lvl, "numFmt")[0]?.getAttribute("w:val")
			lvls[ilvl] = fmt === "bullet" ? "bullet" : "decimal"
		}
		abstract[id] = lvls
	}
	const out: NumberingMap = {}
	for (const num of byTag(doc, "num")) {
		const id = num.getAttribute("w:numId") ?? num.getAttribute("numId")
		const abs = byTag(num, "abstractNumId")[0]?.getAttribute("w:val")
		if (id != null && abs != null && abstract[abs]) out[id] = abstract[abs]
	}
	return out
}

/** styles.xml → styleId → heading level (name "heading N" or styleId
 *  "HeadingN"), so localized styleIds still map correctly. */
function loadHeadingStyles(pkg: OoxmlPackage): Map<string, number> {
	const out = new Map<string, number>()
	const src = decodePart(pkg, "word/styles.xml")
	if (!src) return out
	const doc = parseXml(src)
	for (const style of byTag(doc, "style")) {
		if ((style.getAttribute("w:type") ?? style.getAttribute("type")) !== "paragraph") continue
		const id = style.getAttribute("w:styleId") ?? style.getAttribute("styleId")
		if (!id) continue
		const name = byTag(style, "name")[0]?.getAttribute("w:val") ?? ""
		const m = /^heading\s*([1-6])$/i.exec(name.trim()) ?? /^Heading([1-6])$/.exec(id)
		if (m) out.set(id, Number(m[1]))
	}
	return out
}

interface Notes {
	comments: Map<string, string>
	footnotes: Map<string, string>
}

function loadNotes(pkg: OoxmlPackage): Notes {
	const comments = new Map<string, string>()
	const csrc = decodePart(pkg, "word/comments.xml")
	if (csrc) {
		const doc = parseXml(csrc)
		for (const c of byTag(doc, "comment")) {
			const id = c.getAttribute("w:id")
			if (id == null) continue
			const author = c.getAttribute("w:author") ?? "unknown"
			const date = (c.getAttribute("w:date") ?? "").slice(0, 10)
			const text = textOfDocumentElement(c)
			comments.set(id, `${author}${date ? ` (${date})` : ""}: ${text.trim()}`)
		}
	}
	const footnotes = new Map<string, string>()
	const fsrc = decodePart(pkg, "word/footnotes.xml")
	if (fsrc) {
		const doc = parseXml(fsrc)
		for (const f of byTag(doc, "footnote")) {
			const id = f.getAttribute("w:id")
			if (id == null || Number(id) < 0) continue // -1/0 are separator/continuation
			footnotes.set(id, textOfDocumentElement(f).trim())
		}
	}
	return { comments, footnotes }
}

/** Concatenated visible text under an element: w:t (skipping delText),
 *  w:tab as \t, w:br as \n. */
function textOfDocumentElement(root: XmlElement | XmldDocument): string {
	let text = ""
	const walk = (el: XmlElement, mode: "keep" | "drop") => {
		const tag = el.tagName
		const nextMode = tag === "w:del" || tag === "w:delText" ? "drop" : mode
		if (mode === "keep" && nextMode === "keep") {
			if (tag === "w:t") text += el.textContent ?? ""
			else if (tag === "w:tab") text += "\t"
			else if (tag === "w:br") text += "\n"
		}
		for (let i = 0; i < el.childNodes.length; i++) {
			const child = el.childNodes.item(i)
			if (child?.nodeType === 1) walk(child as XmlElement, nextMode)
		}
	}
	if (root.nodeType === 9) {
		walk((root as XmldDocument).documentElement as XmlElement, "keep")
	} else {
		walk(root as XmlElement, "keep")
	}
	return text
}

interface RenderCtx {
	numbering: NumberingMap
	headings: Map<string, number>
	notes: Notes
	footnotesUsed: Set<string>
	images: number
}

function paragraphMarkdown(p: XmlElement, ctx: RenderCtx): { line?: string; annotations: string[] } {
	const pPr = byTag(p, "pPr").find((el) => el.parentNode === p)
	const annotations: string[] = []
	const insAuthors = new Set<string>()
	const delAuthors = new Set<string>()
	const commentIds = new Set<string>()
	let text = ""

	const walk = (el: XmlElement, mode: "keep" | "del") => {
		const tag = el.tagName
		let nextMode = mode
		if (tag === "w:ins") {
			nextMode = "keep"
			const author = el.getAttribute("w:author")
			if (author) insAuthors.add(author)
		} else if (tag === "w:del") {
			nextMode = "del"
			const author = el.getAttribute("w:author")
			if (author) delAuthors.add(author)
		} else if (tag === "w:commentRangeStart") {
			const id = el.getAttribute("w:id")
			if (id != null) commentIds.add(id)
		} else if (tag === "w:footnoteReference") {
			const id = el.getAttribute("w:id")
			if (id != null && ctx.notes.footnotes.has(id)) {
				ctx.footnotesUsed.add(id)
				text += `[^${id}]`
			}
		} else if (tag === "w:drawing") {
			ctx.images++
			if (mode === "keep") text += "[image]"
		} else if (mode === "keep") {
			if (tag === "w:t") text += el.textContent ?? ""
			else if (tag === "w:tab") text += "\t"
			else if (tag === "w:br") text += "\n"
		}
		for (let i = 0; i < el.childNodes.length; i++) {
			const child = el.childNodes.item(i)
			if (child?.nodeType === 1) walk(child as XmlElement, nextMode)
		}
	}
	walk(p, "keep")

	const trimmed = text.trim()
	const hasContent = trimmed.length > 0 || insAuthors.size > 0 || delAuthors.size > 0
	if (!hasContent) return { annotations }

	let line = trimmed
	const styleId = pPr ? (byTag(pPr, "pStyle")[0]?.getAttribute("w:val") ?? undefined) : undefined
	const headingLevel = styleId ? ctx.headings.get(styleId) : undefined
	if (headingLevel) {
		line = `${"#".repeat(headingLevel)} ${line}`
	} else if (pPr) {
		const numPr = byTag(pPr, "numPr")[0]
		if (numPr) {
			const numId = byTag(numPr, "numId")[0]?.getAttribute("w:val")
			const ilvl = Number(byTag(numPr, "ilvl")[0]?.getAttribute("w:val") ?? 0)
			if (numId && ctx.numbering[numId]) {
				const fmt = ctx.numbering[numId][ilvl] ?? "bullet"
				line = `${"  ".repeat(ilvl)}${fmt === "bullet" ? "-" : "1."} ${line}`
			}
		}
	}
	for (const author of insAuthors) annotations.push(`> [inserted by ${author}]`)
	for (const author of delAuthors) annotations.push(`> [deleted by ${author}]`)
	for (const id of commentIds) {
		const c = ctx.notes.comments.get(id)
		if (c) annotations.push(`> [comment ${id}] ${c}`)
	}
	return { line, annotations }
}

function tableMarkdown(tbl: XmlElement, tableIndex: number): string {
	const rows: string[][] = []
	for (const tr of byTag(tbl, "tr")) {
		const row: string[] = []
		for (const tc of byTag(tr, "tc")) {
			// vMerge continuation cells are empty - keep the column aligned.
			const cell = textOfDocumentElement(tc).trim().replace(/\n+/g, " ")
			const span = Number(byTag(tc, "gridSpan")[0]?.getAttribute("w:val") ?? 1)
			row.push(cell)
			for (let i = 1; i < span; i++) row.push("")
		}
		rows.push(row)
	}
	if (rows.length === 0) return `[table ${tableIndex}]\n(empty table)`
	return `[table ${tableIndex}]\n${renderMarkdownTable(rows[0], rows.slice(1))}`
}

export async function extractDocx(data: Uint8Array): Promise<DocxExtraction> {
	const pkg = await openOoxml(data)
	if (!pkg.hasXml("word/document.xml")) {
		throw new DocumentError("corrupt", "Missing word/document.xml", "docx")
	}
	const documentXml = decodePart(pkg, "word/document.xml")
	if (documentXml === undefined) throw new DocumentError("corrupt", "Missing word/document.xml", "docx")
	// The extractor only ever needs the decoded string; drop the inflated
	// bytes from the package cache (~78 MB on a 20 MB cap file).
	pkg.remove("word/document.xml")

	const blocks = scanBlocks(documentXml)
	const numbering = loadNumbering(pkg)
	const headings = loadHeadingStyles(pkg)
	const notes = loadNotes(pkg)
	const totalImages = (documentXml.match(/<a:blip\b/g) ?? []).length
	const trackedChanges = /<w:(ins|del)\b/.test(documentXml)

	// Outline: heading detection on the raw fragment text — no DOM per block.
	const outline: string[] = []
	const OUTLINE_CAP = 200
	let paragraphIndex = 0
	for (const span of blocks) {
		if (span.kind !== "p") continue
		paragraphIndex++
		const frag = documentXml.slice(span.start, Math.min(span.end, span.start + 400))
		const m = /<w:pStyle\b[^>]*w:val="(Heading([1-6]))"/i.exec(frag)
		if (!m) continue
		if (outline.length < OUTLINE_CAP) {
			const text = stripTags(documentXml.slice(span.start, span.end)).trim()
			if (text) outline.push(`b${paragraphIndex}: ${"#".repeat(Number(m[2]))} ${text}`)
		}
	}
	if (paragraphIndex > 0 && outline.length === OUTLINE_CAP) {
		outline.push(`… outline capped at ${OUTLINE_CAP} headings`)
	}

	// Core properties for `info` (docProps/core.xml is tiny).
	let infoTitle: string | undefined
	let infoCreator: string | undefined
	let infoModifiedBy: string | undefined
	const coreXml = decodePart(pkg, "docProps/core.xml")
	if (coreXml) {
		const core = parseXml(coreXml)
		const pick = (name: string) => byTag(core, name)[0]?.textContent || undefined
		infoTitle = pick("title")
		infoCreator = pick("creator")
		infoModifiedBy = pick("lastModifiedBy")
	}

	// Namespace declarations every block fragment parses under, derived from
	// the document root (Word's full `w14:`/`mc:`/`wps:` set included).
	const nsDecls = fragmentNamespaces(documentXml, FRAGMENT_REQUIRED)

	const extractionNotes: string[] = []
	if (trackedChanges) extractionNotes.push("contains tracked changes — shown as annotations, never applied")
	if (notes.comments.size > 0) extractionNotes.push(`contains ${notes.comments.size} comment(s)`)

	// Per-kind ordinal (1-based) for every block, computed once: paragraph N
	// gets locator `pN`, table N gets `[table N]`. Windows and `blockText`
	// index into this array, so numbering is stable across calls.
	const ordinals: number[] = []
	{
		let p = 0
		let t = 0
		for (const span of blocks) ordinals.push(span.kind === "p" ? ++p : ++t)
	}

	// Shared render context: footnotes used inside the current window
	// accumulate so the footnotes trailer is accurate.
	let sharedCtx: RenderCtx = freshCtx()

	function freshCtx(): RenderCtx {
		return { numbering, headings, notes, footnotesUsed: new Set(), images: 0 }
	}

	const renderBlock = (i: number): string | undefined => {
		const span = blocks[i]
		const num = ordinals[i]
		const fragment = documentXml.slice(span.start, span.end)
		const wrapped = parseFragment(fragment, "w:document", nsDecls)
		if (span.kind === "tbl") {
			return tableMarkdown(byTag(wrapped, "tbl")[0], num)
		}
		const p = byTag(wrapped, "p").filter((el) => el.parentNode === wrapped.documentElement)[0]
		if (!p) return undefined
		const { line, annotations } = paragraphMarkdown(p, sharedCtx)
		if (!line && annotations.length === 0) return undefined
		return [line ? `p${num}: ${line}` : `p${num}:`, ...annotations].join("\n")
	}

	return {
		totalBlocks: blocks.length,
		tables: blocks.filter((b) => b.kind === "tbl").length,
		images: totalImages,
		outline,
		notes: extractionNotes,
		info: {
			title: infoTitle,
			creator: infoCreator,
			lastModifiedBy: infoModifiedBy,
			trackedChanges,
			comments: notes.comments.size,
			footnotes: notes.footnotes.size,
		},
		window(opts = {}) {
			const start = Math.max(1, opts.start ?? 1)
			const end = Math.min(opts.end ?? blocks.length, blocks.length)
			const maxChars = opts.maxChars ?? MAX_OUTPUT_CHARS
			sharedCtx = freshCtx()
			const lines: string[] = []
			let used = 0
			let truncated = false
			let to = start - 1
			for (let i = start - 1; i < end; i++) {
				const rendered = renderBlock(i)
				to = i + 1
				if (rendered === undefined) continue
				if (used + rendered.length + 2 > maxChars) {
					truncated = true
					to = i // this block did not fit; caller continues from it
					break
				}
				lines.push(rendered)
				used += rendered.length + 2
			}
			let markdown = lines.join("\n\n")
			if (sharedCtx.footnotesUsed.size > 0) {
				const fn = [...sharedCtx.footnotesUsed].map((id) => `[^${id}]: ${notes.footnotes.get(id)}`)
				markdown += `\n\n### Footnotes\n\n${fn.join("\n")}`
			}
			return { from: start, to, markdown, truncated }
		},
		blockText(index: number) {
			const span = blocks[index - 1]
			if (!span) throw new DocumentError("corrupt", `No body block ${index} (document has ${blocks.length})`, "docx")
			return stripTags(documentXml.slice(span.start, span.end)).trim()
		},
	}
}
