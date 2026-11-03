/**
 * `pptx.mjs check` — static defect scan for a deck. Findings are formatted as
 * one line each, with the slide and `[shape "..."]` locator they came from.
 *
 * TEXT OVERFLOW HEURISTIC (spec, fixed before implementation)
 *
 * No font metrics exist without rendering, so overflow is an estimate and is
 * reported as "likely overflow", never a hard failure:
 *   - Box: the shape's a:xfrm off/ext in EMU → points (1pt = 12700 EMU),
 *     minus the DrawingML default insets (0.1" left/right = 7.2pt each,
 *     0.05" top/bottom = 3.6pt each). Shapes without an xfrm are skipped.
 *   - Font size: the largest explicit rPr sz (in hundredths of a point) among
 *     runs with text in that shape, else the paragraph's defRPr sz, else 18pt
 *     (PowerPoint body text default).
 *   - Wrapping: average character width = 0.5 × font size (Latin average; wide
 *     CJK decks will under-estimate, which keeps false positives low).
 *     Estimated lines per paragraph = ceil(paragraph width / inner width),
 *     minimum 1 per paragraph that has text.
 *   - Height: lines × font size × 1.2 line spacing. A shape is flagged when
 *     the estimate exceeds the inner height by more than 5% (tolerance that
 *     absorbs the char-width average on real decks).
 *
 * Other rules:
 *   - p:pic shapes with empty cNvPr descr → missing alt text.
 *   - Shapes whose bbox extends past the slide bbox (sldSz) → off-slide.
 */

import type { Element, Document as XmlDocument } from "@xmldom/xmldom"
import { extractPptxShapeText, joinOoxmlPart, ooxmlRelsPath, parseOoxmlRels } from "./extractors/pptx.js"
import { DocumentError } from "./model.js"
import { type OoxmlPackage, openOoxml } from "./ooxml/package.js"
import { byTag } from "./ooxml/xml.js"
import { luminanceOf } from "./writers/pptx-layout.js"

export interface CheckFinding {
	/** 1-based slide number, or 0 for deck-level findings (e.g. monotony). */
	slide: number
	shape?: string
	kind: "text-overflow" | "off-slide" | "missing-alt-text" | "overlap" | "low-contrast" | "monotony" | "dead-space"
	detail: string
}

const EMU_PER_PT = 12700
const DEFAULT_FONT_PT = 18
const LINE_SPACING = 1.2
const AVG_CHAR_WIDTH_RATIO = 0.5
const OVERFLOW_TOLERANCE = 1.05
const SIDE_INSET_PT = 7.2
const TOP_INSET_PT = 3.6

interface BBox {
	x: number
	y: number
	w: number
	h: number
}

function bboxOf(sp: Element): BBox | undefined {
	for (const xfrm of byTag(sp, "xfrm")) {
		let off = { x: 0, y: 0 }
		for (const offEl of byTag(xfrm, "off")) {
			off = { x: Number(offEl.getAttribute("x") ?? 0), y: Number(offEl.getAttribute("y") ?? 0) }
		}
		for (const extEl of byTag(xfrm, "ext")) {
			const cx = Number(extEl.getAttribute("cx"))
			const cy = Number(extEl.getAttribute("cy"))
			if (cx > 0 && cy > 0) {
				return { x: off.x / EMU_PER_PT, y: off.y / EMU_PER_PT, w: cx / EMU_PER_PT, h: cy / EMU_PER_PT }
			}
		}
	}
	return undefined
}

/** Largest explicit run font size in the shape (points), else undefined. */
function fontSizeOf(sp: Element): number {
	let size: number | undefined
	for (const rPr of byTag(sp, "rPr")) {
		const sz = Number(rPr.getAttribute("sz"))
		if (sz > 0 && (size === undefined || sz > size)) size = sz
	}
	for (const defRPr of byTag(sp, "defRPr")) {
		if (size !== undefined) break
		const sz = Number(defRPr.getAttribute("sz"))
		if (sz > 0) size = sz
	}
	return size !== undefined ? size / 100 : DEFAULT_FONT_PT
}

/** Paragraph texts of the shape (drawing-ML txBody only). */
function paragraphsOf(sp: Element): string[] {
	const { text } = extractPptxShapeText(sp)
	return text.split("\n").filter((line) => line.trim().length > 0)
}

function checkTextOverflow(slideIdx: number, sp: Element, name: string | undefined, findings: CheckFinding[]): void {
	const bbox = bboxOf(sp)
	if (!bbox) return
	const font = fontSizeOf(sp)
	const innerW = Math.max(1, bbox.w - 2 * SIDE_INSET_PT)
	const innerH = Math.max(1, bbox.h - 2 * TOP_INSET_PT)
	let estimated = 0
	for (const para of paragraphsOf(sp)) {
		const lines = Math.max(1, Math.ceil((para.length * AVG_CHAR_WIDTH_RATIO * font) / innerW))
		estimated += lines * font * LINE_SPACING
	}
	if (estimated > innerH * OVERFLOW_TOLERANCE) {
		findings.push({
			slide: slideIdx,
			shape: name,
			kind: "text-overflow",
			detail: `likely text overflow: ~${Math.round(estimated)}pt of content in a ${Math.round(innerH)}pt box`,
		})
	}
}

function checkOffSlide(
	slideIdx: number,
	sp: Element,
	name: string | undefined,
	slideSize: { width: number; height: number } | undefined,
	findings: CheckFinding[],
): void {
	if (!slideSize) return
	const bbox = bboxOf(sp)
	if (!bbox) return
	if (bbox.x + bbox.w > slideSize.width + 1 || bbox.y + bbox.h > slideSize.height + 1 || bbox.x < -1 || bbox.y < -1) {
		findings.push({
			slide: slideIdx,
			shape: name,
			kind: "off-slide",
			detail: `bbox (${Math.round(bbox.x)},${Math.round(bbox.y)} ${Math.round(bbox.w)}x${Math.round(bbox.h)}pt) extends past the slide (${Math.round(slideSize.width)}x${Math.round(slideSize.height)}pt)`,
		})
	}
}

function checkMissingAltText(slideIdx: number, pic: Element, findings: CheckFinding[]): void {
	for (const cNvPr of byTag(pic, "cNvPr")) {
		const descr = cNvPr.getAttribute("descr")
		if (!descr?.trim()) {
			findings.push({
				slide: slideIdx,
				shape: cNvPr.getAttribute("name") ?? undefined,
				kind: "missing-alt-text",
				detail: "picture has no alt text",
			})
		}
		break
	}
}

/* ------------------------- overlap / contrast / monotony ------------------------- */

/** Estimated rendered height (pt) of a shape's text — same formula as the overflow rule. */
function estimatedContentPt(sp: Element): number {
	const bbox = bboxOf(sp)
	if (!bbox) return 0
	const font = fontSizeOf(sp)
	const innerW = Math.max(1, bbox.w - 2 * SIDE_INSET_PT)
	let estimated = 0
	for (const para of paragraphsOf(sp)) {
		const lines = Math.max(1, Math.ceil((para.length * AVG_CHAR_WIDTH_RATIO * font) / innerW))
		estimated += lines * font * LINE_SPACING
	}
	return estimated
}

/** Bbox enlarged to the estimated content height — catches text spilling past its box. */
function extendedBBox(sp: Element): BBox | undefined {
	const bbox = bboxOf(sp)
	if (!bbox) return undefined
	const est = estimatedContentPt(sp)
	return est > bbox.h ? { ...bbox, h: est } : bbox
}

const OVERLAP_AREA_FRACTION = 0.3

/** Two text-bearing shapes whose (content-extended) boxes intersect. */
function checkOverlaps(
	slideIdx: number,
	textShapes: Array<{ name: string | undefined; sp: Element }>,
	findings: CheckFinding[],
): void {
	for (let a = 0; a < textShapes.length; a++) {
		for (let b = a + 1; b < textShapes.length; b++) {
			const ba = extendedBBox(textShapes[a].sp)
			const bb = extendedBBox(textShapes[b].sp)
			if (!ba || !bb) continue
			const ix = Math.max(0, Math.min(ba.x + ba.w, bb.x + bb.w) - Math.max(ba.x, bb.x))
			const iy = Math.max(0, Math.min(ba.y + ba.h, bb.y + bb.h) - Math.max(ba.y, bb.y))
			const smaller = Math.min(ba.w * ba.h, bb.w * bb.h)
			if (smaller > 0 && (ix * iy) / smaller > OVERLAP_AREA_FRACTION) {
				findings.push({
					slide: slideIdx,
					shape: textShapes[a].name,
					kind: "overlap",
					detail: `text in "${textShapes[a].name ?? "?"}" likely overlaps "${textShapes[b].name ?? "?"}"`,
				})
			}
		}
	}
}

/** Explicit run colors in a shape: srgbClr values found under rPr/solidFill. */
function runColors(sp: Element): { explicit: string[]; hasUncolored: boolean } {
	const explicit: string[] = []
	let hasUncolored = false
	for (const rPr of byTag(sp, "rPr")) {
		let color: string | undefined
		for (const sf of byTag(rPr, "solidFill")) {
			for (const srgb of byTag(sf, "srgbClr")) color = srgb.getAttribute("val") ?? undefined
		}
		if (color) explicit.push(color)
		else hasUncolored = true
	}
	return { explicit, hasUncolored }
}

const LOW_CONTRAST_BG_LUM = 0.35

/** On a dark slide, text that is (or inherits) dark reads as nothing. */
function checkContrast(
	slideIdx: number,
	textShapes: Array<{ name: string | undefined; sp: Element }>,
	slideBg: string | undefined,
	findings: CheckFinding[],
): void {
	const bgLum = luminanceOf(slideBg)
	if (bgLum === undefined || bgLum >= LOW_CONTRAST_BG_LUM) return
	for (const { name, sp } of textShapes) {
		const { explicit, hasUncolored } = runColors(sp)
		const darkest = Math.min(...explicit.map((c) => luminanceOf(c) ?? 1))
		if (explicit.length > 0 && darkest < LOW_CONTRAST_BG_LUM) {
			findings.push({
				slide: slideIdx,
				shape: name,
				kind: "low-contrast",
				detail: "dark text on a dark background — recolor toward the light end of the palette",
			})
		} else if (explicit.length === 0 && hasUncolored) {
			findings.push({
				slide: slideIdx,
				shape: name,
				kind: "low-contrast",
				detail: "text without an explicit color on a dark background (theme default is dark)",
			})
		}
	}
}

/** Slide background hex from <p:bg>, if the slide sets one. */
function slideBackgroundOf(slide: XmlDocument | Element): string | undefined {
	for (const bg of byTag(slide, "bg")) {
		for (const sf of byTag(bg, "solidFill")) {
			for (const srgb of byTag(sf, "srgbClr")) {
				const val = srgb.getAttribute("val")
				if (val) return val
			}
		}
	}
	return undefined
}

/** A "plain" slide: at most two text shapes, no pictures, tables or charts. */
function isPlainSlide(slide: XmlDocument | Element): boolean {
	if (byTag(slide, "pic").length > 0 || byTag(slide, "graphicFrame").length > 0) return false
	let textShapes = 0
	for (const sp of byTag(slide, "sp")) {
		if (paragraphsOf(sp).length > 0) textShapes++
		if (textShapes > 2) return false
	}
	return textShapes > 0
}

/** A slide whose content spans < 45% of the slide height reads as a void. */
const DEAD_SPACE_FRACTION = 0.45

function checkDeadSpace(
	slideIdx: number,
	textShapes: Array<{ sp: Element }>,
	slideSize: { width: number; height: number },
	findings: CheckFinding[],
): void {
	const bboxes = textShapes.map((t) => bboxOf(t.sp)).filter((b): b is BBox => b !== undefined)
	if (bboxes.length < 2) return
	const top = Math.min(...bboxes.map((b) => b.y))
	const bottom = Math.max(...bboxes.map((b) => b.y + b.h))
	const span = bottom - top
	if (span < DEAD_SPACE_FRACTION * slideSize.height) {
		findings.push({
			slide: slideIdx,
			kind: "dead-space",
			detail: `content spans ~${Math.round((span / slideSize.height) * 100)}% of the slide height — add a visual block (stats/cards/flow/code) or let the layout fill the canvas`,
		})
	}
}

const MONOTONY_MIN_SLIDES = 6
const MONOTONY_PLAIN_FRACTION = 0.8

function checkMonotony(slideXmls: XmlDocument[], findings: CheckFinding[]): void {
	if (slideXmls.length < MONOTONY_MIN_SLIDES) return
	const plain = slideXmls.filter(isPlainSlide).length
	if (plain / slideXmls.length > MONOTONY_PLAIN_FRACTION) {
		findings.push({
			slide: 0,
			kind: "monotony",
			detail: `${plain} of ${slideXmls.length} slides are title-and-text only — vary layouts (cards, stats, quotes, flows, two-column) so every slide isn't the same shape`,
		})
	}
}

export async function checkPptx(data: Uint8Array): Promise<CheckFinding[]> {
	const pkg = await openOoxml(data)
	if (!pkg.hasXml("ppt/presentation.xml")) {
		throw new DocumentError("corrupt", "Missing ppt/presentation.xml", "pptx")
	}
	const slides = slidePartsOf(pkg)
	const slideSize = slideSizeOf(pkg)
	const findings: CheckFinding[] = []
	const slideXmls: XmlDocument[] = []
	for (let i = 0; i < slides.length; i++) {
		const slide = pkg.getXml(slides[i].path)
		slideXmls.push(slide)
		const textShapes = byTag(slide, "sp")
			.map((sp) => ({ sp, name: extractPptxShapeText(sp).name }))
			.filter((shape) => paragraphsOf(shape.sp).length > 0)
		for (const { sp, name } of textShapes) {
			checkTextOverflow(i + 1, sp, name, findings)
			checkOffSlide(i + 1, sp, name, slideSize, findings)
		}
		// Shapes without text can still leave the slide bounds.
		const textless = byTag(slide, "sp").filter((sp) => paragraphsOf(sp).length === 0)
		for (const sp of textless) {
			checkOffSlide(i + 1, sp, extractPptxShapeText(sp).name, slideSize, findings)
		}
		checkOverlaps(i + 1, textShapes, findings)
		checkContrast(i + 1, textShapes, slideBackgroundOf(slide), findings)
		checkDeadSpace(i + 1, textShapes, slideSize ?? { width: 0, height: 0 }, findings)
		for (const pic of byTag(slide, "pic")) {
			checkMissingAltText(i + 1, pic, findings)
		}
	}
	checkMonotony(slideXmls, findings)
	return findings
}

function slidePartsOf(pkg: OoxmlPackage): Array<{ path: string; hidden: boolean }> {
	if (!pkg.hasXml("ppt/presentation.xml")) return []
	const presentation = pkg.getXml("ppt/presentation.xml")
	const presRels: Record<string, string> = pkg.hasXml(ooxmlRelsPath("ppt/presentation.xml"))
		? parseOoxmlRels(pkg.getXml(ooxmlRelsPath("ppt/presentation.xml")))
		: {}
	const slides: Array<{ path: string; hidden: boolean }> = []
	for (const sldId of byTag(presentation, "sldId")) {
		const rid = sldId.getAttribute("r:id") ?? sldId.getAttribute("id")
		const target = rid ? presRels[rid] : undefined
		if (!target) continue
		slides.push({ path: joinOoxmlPart("ppt", target), hidden: sldId.getAttribute("show") === "0" })
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

/** Text rendering for the CLI. */
export function renderFindings(findings: CheckFinding[]): string {
	if (findings.length === 0) return "no findings"
	return findings
		.map((f) =>
			f.slide === 0
				? `deck ${f.shape ? ` [shape "${f.shape}"]` : ""} ${f.kind}: ${f.detail}`
				: `slide ${f.slide}${f.shape ? ` [shape "${f.shape}"]` : ""} ${f.kind}: ${f.detail}`,
		)
		.join("\n")
}
