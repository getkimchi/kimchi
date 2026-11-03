/**
 * `pptx.mjs inspect` — the deck's edit vocabulary: slide layouts (with their
 * placeholders) and, per slide, every shape's exact `[shape "..."]` name,
 * placeholder role, and text size. Edit ops reference these names verbatim,
 * so they are printed exactly as the edit parser will match them.
 */

import type { Element } from "@xmldom/xmldom"
import { extractPptxShapeText, joinOoxmlPart, ooxmlPartDir, ooxmlRelsPath, parseOoxmlRels } from "./extractors/pptx.js"
import { DocumentError } from "./model.js"
import { type OoxmlPackage, openOoxml } from "./ooxml/package.js"
import { byTag } from "./ooxml/xml.js"
import { listTemplateLayouts } from "./writers/template.js"

export interface PlaceholderInfo {
	/** Placeholder type attr, e.g. "title", "body" — "body" when absent. */
	type: string
	/** Placeholder idx attr (0+), when present. */
	idx?: number
}

export interface InspectedSlide {
	/** 1-based position in sldIdLst order. */
	index: number
	hidden: boolean
	/** Layout display name, or the layout part path when unnamed. */
	layoutName?: string
	shapes: Array<{
		name?: string
		placeholder?: PlaceholderInfo
		chars: number
	}>
	/** Tables in document order — the exact `[table N]` vocabulary edit takes. */
	tables: Array<{ index: number; rows: number; cols: number }>
}

export interface InspectedDeck {
	slideSizePt?: { width: number; height: number }
	/** Layout name → placeholder inventory (the vocabulary append_slide takes). */
	layouts: Array<{ name: string; placeholders: Array<{ type: string; idx?: number }> }>
	slides: InspectedSlide[]
}

const EMU_PER_PT = 12700

function readPlaceholder(sp: Element): PlaceholderInfo | undefined {
	for (const ph of byTag(sp, "ph")) {
		const type = ph.getAttribute("type") ?? "body"
		const idxAttr = ph.getAttribute("idx")
		return { type, idx: idxAttr ? Number(idxAttr) : undefined }
	}
	return undefined
}

/** Slide's layout part path via its rels, or undefined when absent. */
function layoutPartOf(pkg: OoxmlPackage, slidePath: string): string | undefined {
	const relsPath = ooxmlRelsPath(slidePath)
	if (!pkg.hasXml(relsPath)) return undefined
	const rels = parseOoxmlRels(pkg.getXml(relsPath))
	for (const target of Object.values(rels)) {
		const resolved = joinOoxmlPart(ooxmlPartDir(slidePath), target)
		if (/slideLayout\d+\.xml$/.test(resolved)) return resolved
	}
	return undefined
}

/** Display name of a slide layout: cSld/@name, falling back to its part path. */
function layoutNameOf(pkg: OoxmlPackage, layoutPath: string): string {
	if (!pkg.hasXml(layoutPath)) return layoutPath
	const layout = pkg.getXml(layoutPath)
	for (const cSld of byTag(layout, "cSld")) {
		return cSld.getAttribute("name") ?? layoutPath
	}
	return layoutPath
}

/** All slides in true (sldIdLst) order with their part paths. */
function slideParts(pkg: OoxmlPackage): Array<{ path: string; hidden: boolean }> {
	const presentation = pkg.getXml("ppt/presentation.xml")
	const presRels: Record<string, string> = pkg.hasXml(ooxmlRelsPath("ppt/presentation.xml"))
		? parseOoxmlRels(pkg.getXml(ooxmlRelsPath("ppt/presentation.xml")))
		: {}
	const slides: Array<{ path: string; hidden: boolean }> = []
	for (const sldId of byTag(presentation, "sldId")) {
		const rid = sldId.getAttribute("r:id") ?? sldId.getAttribute("id")
		const show = sldId.getAttribute("show")
		const target = rid ? presRels[rid] : undefined
		if (!target) continue
		slides.push({ path: joinOoxmlPart("ppt", target), hidden: show === "0" })
	}
	return slides
}

function slideSizeOf(pkg: OoxmlPackage): { width: number; height: number } | undefined {
	const presentation = pkg.getXml("ppt/presentation.xml")
	for (const sldSz of byTag(presentation, "sldSz")) {
		const cx = Number(sldSz.getAttribute("cx"))
		const cy = Number(sldSz.getAttribute("cy"))
		if (cx > 0 && cy > 0) return { width: cx / EMU_PER_PT, height: cy / EMU_PER_PT }
	}
	return undefined
}

export async function inspectPptx(data: Uint8Array): Promise<InspectedDeck> {
	const pkg = await openOoxml(data)
	if (!pkg.hasXml("ppt/presentation.xml")) {
		throw new DocumentError("corrupt", "Missing ppt/presentation.xml", "pptx")
	}
	const slides = slideParts(pkg)
	if (slides.length === 0) throw new DocumentError("corrupt", "PPTX has no slides in sldIdLst.", "pptx")

	const layoutNames = new Set<string>()
	const inspected: InspectedSlide[] = []
	for (let i = 0; i < slides.length; i++) {
		const layoutPath = layoutPartOf(pkg, slides[i].path)
		let layoutName: string | undefined
		if (layoutPath) {
			layoutName = layoutNameOf(pkg, layoutPath)
			layoutNames.add(layoutName)
		}
		const slide = pkg.getXml(slides[i].path)
		const shapes: InspectedSlide["shapes"] = []
		for (const sp of byTag(slide, "sp")) {
			// Only top-level shapes and group children; layout/notes parts excluded by construction.
			const { name, text } = extractPptxShapeText(sp)
			shapes.push({ name, placeholder: readPlaceholder(sp), chars: text.length })
		}
		// Tables belong in inspect output — their document order is the [table N]
		// edit vocabulary (same counting as the editor's byTag(slide, "tbl")).
		const tables = byTag(slide, "tbl").map((tbl, t) => {
			const rows = byTag(tbl, "tr").length
			const firstRow = byTag(tbl, "tr")[0]
			return { index: t + 1, rows, cols: firstRow ? byTag(firstRow, "tc").length : 0 }
		})
		inspected.push({ index: i + 1, hidden: slides[i].hidden, layoutName, shapes, tables })
	}
	const layouts = listTemplateLayouts(pkg)
		.filter((l) => layoutNames.has(l.name))
		.map((l) => ({ name: l.name, placeholders: l.placeholders }))
	return { slideSizePt: slideSizeOf(pkg), layouts, slides: inspected }
}

/** Text rendering for the CLI: one block per slide, layouts listed first. */
export function renderInspection(deck: InspectedDeck): string {
	const lines: string[] = []
	if (deck.slideSizePt) {
		lines.push(`slide size: ${deck.slideSizePt.width}pt x ${deck.slideSizePt.height}pt`)
	}
	for (const layout of deck.layouts) {
		const phs =
			layout.placeholders.length === 0
				? ""
				: ` — placeholders: ${layout.placeholders.map((p) => `${p.type}${p.idx !== undefined ? ` idx ${p.idx}` : ""}`).join(", ")}`
		lines.push(`layout "${layout.name}"${phs}`)
	}
	if (deck.layouts.length === 0) lines.push("layouts: (none)")
	for (const slide of deck.slides) {
		const hidden = slide.hidden ? " (hidden)" : ""
		const layout = slide.layoutName ? ` layout "${slide.layoutName}"` : ""
		lines.push(`slide ${slide.index}${hidden}${layout}`)
		for (const shape of slide.shapes) {
			const name = shape.name ? `[shape "${shape.name}"]` : "(unnamed shape)"
			const ph = shape.placeholder
				? ` placeholder(${shape.placeholder.type}${shape.placeholder.idx !== undefined ? `, idx ${shape.placeholder.idx}` : ""})`
				: ""
			lines.push(`  ${name}${ph} ${shape.chars} chars`)
		}
		for (const table of slide.tables) {
			lines.push(`  [table ${table.index}] ${table.rows} rows x ${table.cols} cols`)
		}
	}
	return lines.join("\n")
}
