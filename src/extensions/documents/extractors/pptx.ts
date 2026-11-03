/**
 * PPTX extractor on the shared OOXML layer (jszip + xmldom). Reads slides in
 * sldIdLst order (reordered decks read correctly), honors hidden slides
 * (show="0"), renders shape text with `[shape "name"]` locators, tables as
 * markdown tables, notes from the slide's notesSlide part, and charts as a
 * placeholder marker (Phase 5 renders them visually).
 */

import type { Element, Document as XmlDocument } from "@xmldom/xmldom"
import { renderMarkdownTable } from "../markdown-table.js"
import { DocumentError, type ExtractedDocument } from "../model.js"
import { openOoxml } from "../ooxml/package.js"
import { byTag } from "../ooxml/xml.js"

export interface RelMap {
	/** rId → target part path (relative to the part's directory). */
	[rId: string]: string
}

export function parseOoxmlRels(xml: XmlDocument): RelMap {
	const map: RelMap = {}
	for (const rel of byTag(xml, "Relationship")) {
		const id = rel.getAttribute("Id")
		const target = rel.getAttribute("Target")
		if (id && target) map[id] = target
	}
	return map
}

export function joinOoxmlPart(baseDir: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1)
	const segments = `${baseDir}/${target}`.split("/")
	const out: string[] = []
	for (const seg of segments) {
		if (seg === "..") out.pop()
		else if (seg !== "." && seg !== "") out.push(seg)
	}
	return out.join("/")
}

/** Directory of a part path: "ppt/slides/slide1.xml" → "ppt/slides". */
export function ooxmlPartDir(path: string): string {
	const idx = path.lastIndexOf("/")
	return idx < 0 ? "" : path.slice(0, idx)
}

/** Rels part for a part path: "ppt/slides/slide1.xml" → "ppt/slides/_rels/slide1.xml.rels". */
export function ooxmlRelsPath(path: string): string {
	return `${ooxmlPartDir(path)}/_rels/${path.slice(ooxmlPartDir(path).length + 1)}.rels`
}

export function ooxmlTextOf(el: Element): string {
	const texts: string[] = []
	for (const t of byTag(el, "t")) {
		texts.push(t.textContent ?? "")
	}
	return texts.join("")
}

export function ooxmlLocalName(tag: string): string {
	return tag.split(":").pop() ?? tag
}

export function extractPptxShapeText(sp: Element): { name?: string; text: string } {
	let name: string | undefined
	for (const cNvPr of byTag(sp, "cNvPr")) {
		name = cNvPr.getAttribute("name") ?? undefined
		break
	}
	// Paragraph-level joins keep line breaks between a:p paragraphs.
	const paragraphs: string[] = []
	for (const p of byTag(sp, "p")) {
		if (ooxmlLocalName((p.parentNode as Element | null)?.tagName ?? "") !== "txBody") continue
		paragraphs.push(ooxmlTextOf(p))
	}
	return { name, text: paragraphs.filter((line) => line.trim()).join("\n") }
}

function extractTable(tbl: Element): string {
	const rows: string[][] = []
	for (const tr of byTag(tbl, "tr")) {
		const cells: string[] = []
		for (const tc of byTag(tr, "tc")) {
			cells.push(ooxmlTextOf(tc))
		}
		rows.push(cells)
	}
	if (rows.length === 0) return ""
	return renderMarkdownTable(rows[0], rows.slice(1))
}

export async function extractPptx(data: Uint8Array): Promise<ExtractedDocument> {
	const pkg = await openOoxml(data)
	if (!pkg.hasXml("ppt/presentation.xml")) {
		throw new DocumentError("corrupt", "Missing ppt/presentation.xml", "pptx")
	}
	const presentation = pkg.getXml("ppt/presentation.xml")
	const presRels = pkg.hasXml(ooxmlRelsPath("ppt/presentation.xml"))
		? parseOoxmlRels(pkg.getXml(ooxmlRelsPath("ppt/presentation.xml")))
		: {}

	// sldIdLst gives the true slide order; r:id maps to part via rels.
	const slides: { path: string; hidden: boolean }[] = []
	for (const sldId of byTag(presentation, "sldId")) {
		const rid = sldId.getAttribute("r:id") ?? sldId.getAttribute("id")
		const show = sldId.getAttribute("show")
		const target = rid ? presRels[rid] : undefined
		if (!target) continue
		slides.push({ path: joinOoxmlPart("ppt", target), hidden: show === "0" })
	}
	if (slides.length === 0) {
		throw new DocumentError("corrupt", "PPTX has no slides in sldIdLst.", "pptx")
	}

	const notes: string[] = []
	const units: ExtractedDocument["units"] = []
	const outline: string[] = []

	for (let i = 0; i < slides.length; i++) {
		const { path, hidden } = slides[i]
		if (!pkg.hasXml(path)) {
			notes.push(`slide ${i + 1}: missing part ${path}`)
			continue
		}
		const slide = pkg.getXml(path)
		const blocks: string[] = []
		let chartCount = 0
		let tableIndex = 0 // [table N] — document order, the exact vocabulary edit takes
		for (const child of topLevelShapes(slide)) {
			const tag = ooxmlLocalName(child.tagName)
			if (tag === "sp") {
				const { name, text } = extractPptxShapeText(child)
				if (!text.trim()) continue
				blocks.push(name ? `[shape "${name}"]\n${text}` : text)
			} else if (tag === "graphicFrame") {
				const tbl = firstTable(child)
				if (tbl) {
					const md = extractTable(tbl)
					tableIndex += 1
					if (md) blocks.push(`[table ${tableIndex}]\n${md}`)
				} else if (byTag(child, "chart").length > 0) {
					chartCount += 1
					blocks.push("[chart]")
				}
			} else if (tag === "grpSp") {
				const texts = byTag(child, "sp")
					.map((sp) => extractPptxShapeText(sp))
					.filter((t) => t.text.trim())
				for (const t of texts) blocks.push(t.name ? `[shape "${t.name}"]\n${t.text}` : t.text)
			}
		}
		if (chartCount > 0) notes.push(`slide ${i + 1}: ${chartCount} chart(s) shown as [chart] markers`)

		// Notes slide: slide rels → ../notesSlides/notesSlideN.xml
		const slideRelsPath = ooxmlRelsPath(path)
		if (pkg.hasXml(slideRelsPath)) {
			const rels = parseOoxmlRels(pkg.getXml(slideRelsPath))
			for (const target of Object.values(rels)) {
				const notesPath = joinOoxmlPart(ooxmlPartDir(path), target)
				if (!/notesSlide\d+\.xml$/.test(notesPath) || !pkg.hasXml(notesPath)) continue
				const notesDoc = pkg.getXml(notesPath)
				// Only the notes BODY placeholder's text: pull a:p whose nearest sp
				// ancestor carries <p:ph type="body"> (notes slides also contain the
				// slide-image and slide-number placeholders, which leak their text).
				const bodyShape = byTag(notesDoc, "sp").filter((sp) => {
					for (const ph of byTag(sp, "ph")) return (ph.getAttribute("type") ?? "body") === "body"
					return false
				})
				const scope = bodyShape.length > 0 ? bodyShape : byTag(notesDoc, "sp")
				const notesText = scope
					.flatMap((sp) => extractPptxShapeText(sp).text)
					.filter((line) => line.trim())
					.join("\n")
				if (notesText.trim()) blocks.push(`Notes:\n${notesText}`)
			}
		}

		let markdown = blocks.join("\n\n")
		if (hidden) markdown = `*hidden slide*\n\n${markdown}`
		const label = `Slide ${i + 1}`
		units.push({ index: i + 1, label, markdown })
		const first = blocks.find((b) => !b.startsWith("[chart]") && !b.startsWith("Notes:"))
		const headline = first
			? first.split("\n").slice(1).join(" ").slice(0, 80) || first.split("\n")[0].slice(0, 80)
			: "(no text)"
		outline.push(`Slide ${i + 1}${hidden ? " (hidden)" : ""}: ${headline}`)
	}

	return { format: "pptx", unitKind: "slide", units, outline, notes }
}

/** Direct children of the slide's spTree (shapes, graphic frames, groups). */
function topLevelShapes(slide: XmlDocument): Element[] {
	const out: Element[] = []
	for (const spTree of byTag(slide, "spTree")) {
		for (const node of Array.from(spTree.childNodes)) {
			if (node.nodeType === 1) out.push(node as Element)
		}
		break
	}
	return out
}

function firstTable(frame: Element): Element | undefined {
	for (const tbl of byTag(frame, "tbl")) return tbl
	return undefined
}
