/**
 * Pure geometry for the deck writer: palette resolution, element height
 * estimation, and the vertical flow allocator. No pptxgenjs imports — the
 * pitfalls guards reuse the same estimator for `slide-overfull`, and the
 * writer consumes the computed boxes directly, so estimate and render
 * can never drift apart.
 */

import type { Inline } from "../markdown/blocks.js"
import type { DeckTheme, SlideElement, SlideSpec } from "./pptx-model.js"

export const DEFAULT_SLIDE_W = 13.33
export const DEFAULT_SLIDE_H = 7.5
export const MARGIN = 0.6
/** Gap between stacked blocks in the content flow. */
export const FLOW_GAP = 0.35

/** Dark-background decks get light text below this relative luminance. */
export const DARK_BG_LIGHT_TEXT_LUMINANCE = 0.35

/** Relative luminance (0..1) of an RRGGBB hex color; undefined for malformed input. */
export function luminanceOf(hex: string | undefined): number | undefined {
	if (!hex) return undefined
	const clean = hex.replace("#", "")
	if (clean.length !== 6) return undefined
	const r = Number.parseInt(clean.slice(0, 2), 16) / 255
	const g = Number.parseInt(clean.slice(2, 4), 16) / 255
	const b = Number.parseInt(clean.slice(4, 6), 16) / 255
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function slideNeedsLightText(background: string | undefined): boolean {
	const lum = luminanceOf(background)
	return lum !== undefined && lum < DARK_BG_LIGHT_TEXT_LUMINANCE
}

const stripHash = (hex: string) => hex.replace("#", "").toUpperCase()

export interface Palette {
	bg?: string
	dark: boolean
	accent: string
	text: string
	muted: string
	surface: string
	surface2: string
	/** Card outline on surfaces. */
	border: string
	headFont: string
	bodyFont: string
	monoFont: string
	footer?: string
}

export function resolvePalette(theme: DeckTheme): Palette {
	const bg = theme.background !== undefined ? stripHash(theme.background) : undefined
	const dark = slideNeedsLightText(bg)
	return {
		bg,
		dark,
		accent: stripHash(theme.accent ?? "00A3A1"),
		text: theme.text !== undefined ? stripHash(theme.text) : dark ? "FFFFFF" : "22262B",
		muted: theme.muted !== undefined ? stripHash(theme.muted) : dark ? "9BA1AB" : "5A6470",
		surface: theme.surface !== undefined ? stripHash(theme.surface) : dark ? "181A21" : "F2F4F6",
		surface2: theme.surface2 !== undefined ? stripHash(theme.surface2) : dark ? "0A0B0E" : "FFFFFF",
		border: dark ? "2A2E39" : "D8DEE4",
		headFont: theme.headingFont ?? theme.font ?? "Calibri",
		bodyFont: theme.font ?? "Calibri",
		monoFont: theme.monoFont ?? "Courier New",
		footer: theme.footer,
	}
}

export function inlineTextOf(inline: Inline[]): string {
	return inline.map((i) => i.text).join("")
}

/* ------------------------- height estimation ------------------------- */

/** Mean glyph width as a fraction of font size (Latin body text, generous). */
const CHAR_WIDTH_RATIO = 0.52

function estimatedTextHeightPt(text: string, widthIn: number, fontPt: number): number {
	const charsPerLine = Math.max(4, (widthIn * 72) / (CHAR_WIDTH_RATIO * fontPt))
	const lines = Math.max(1, Math.ceil(text.replace(/`/g, "").length / charsPerLine))
	return lines * fontPt * 1.22
}

function bulletsPlainText(el: SlideElement & { type: "bullets" }): string[] {
	const lines: string[] = []
	const walk = (items: typeof el.items) => {
		for (const item of items) {
			lines.push(inlineTextOf(item.inline))
			for (const child of item.children) if (child.type === "bullets") walk(child.items)
		}
	}
	walk(el.items)
	return lines
}

export const PT_PER_IN = 72

/** Estimated rendered height (inches) of one element at the given width. */
export function estimateElementHeight(el: SlideElement, widthIn: number): number {
	switch (el.type) {
		case "heading":
			return 0.5
		case "paragraphs": {
			let pt = 0
			for (const p of el.inline) pt += estimatedTextHeightPt(inlineTextOf(p), widthIn, 16) + 6
			return pt / PT_PER_IN
		}
		case "bullets": {
			let pt = 0
			for (const line of bulletsPlainText(el)) pt += estimatedTextHeightPt(line, widthIn - 0.35, 16) + 7
			return pt / PT_PER_IN
		}
		case "table":
			return (el.rows.length + 1) * 0.34 + 0.1
		case "chart":
			return 4.1
		case "image":
			return 3.0
		case "stats":
			return 1.8
		case "quote": {
			const body = estimatedTextHeightPt(el.text, widthIn - 1.2, 14.5) / PT_PER_IN
			return Math.max(1.6, body + 0.95)
		}
		case "code":
			return el.lines.length * ((11.5 * 1.3) / PT_PER_IN) + 0.95
		case "cards": {
			const n = el.cards.length
			const cols = n <= 2 ? n : n <= 4 ? 2 : 3
			const rows = Math.ceil(n / cols)
			const cardW = (widthIn - 0.3 * (cols - 1)) / cols
			let cardH = 1.35
			for (const c of el.cards) {
				const body = estimatedTextHeightPt(c.body, cardW - 0.55, 11.5) / PT_PER_IN
				cardH = Math.max(cardH, 1.15 + body)
			}
			return rows * cardH + (rows - 1) * 0.3
		}
		case "flow":
			return 1.05
	}
}

/** Chainable: consecutive cards grids collapse to a single grid visually, but keep spacing. */
const isBodyElement = (el: SlideElement) => el.type === "bullets" || el.type === "paragraphs"

export interface ElementBox {
	el: SlideElement
	x: number
	y: number
	w: number
	h: number
}

export interface SlideLayout {
	heading?: { x: number; y: number; w: number; h: number; align: "left" | "center" }
	flow: ElementBox[]
	/** Column boxes for two-column body elements (kept out of `flow`). */
	columns?: ElementBox[]
	/** Estimated bottom edge of all content (inches). */
	contentBottom: number
}

/**
 * Vertical flow allocation: heading at top, elements stacked in source
 * order, two-column slides get their body blocks split across two columns
 * (other elements still flow full-width below).
 */
export function computeSlideLayout(slide: SlideSpec, theme: DeckTheme): SlideLayout {
	const w = theme.slideWidth ?? DEFAULT_SLIDE_W
	const h = theme.slideHeight ?? DEFAULT_SLIDE_H
	const inner = w - 2 * MARGIN
	const hasHeading = slide.heading !== undefined && slide.layoutHint !== "blank"
	const hint = slide.layoutHint

	if (hint === "title" || hint === "hero") {
		const aligned = hint === "title" ? ("center" as const) : ("left" as const)
		const heading = slide.heading !== undefined ? { x: MARGIN, y: 0.4, w: inner, h: 1.3, align: aligned } : undefined
		if (hint === "title") {
			let acc = h * 0.35 + 1.0
			for (const el of slide.elements) acc += estimateElementHeight(el, inner) + FLOW_GAP
			return { heading, flow: [], contentBottom: acc }
		}
		// Hero slots: heading zone (fixed), paragraphs stacked from y=3.4
		// (first is the accent tagline), terminal card after the last paragraph,
		// link row pinned at the bottom. estimateOverflow guards real overrun.
		const paras = slide.elements.filter((e) => e.type === "paragraphs")
		const code = slide.elements.find((e) => e.type === "code")
		let y = 3.4
		for (const el of paras) y += estimateElementHeight(el, inner * 0.72)
		const codeH = code !== undefined ? Math.min(estimateElementHeight(code, 7.0), 2.3) : 0
		return { heading, flow: [], contentBottom: y + (code !== undefined ? 0.15 + codeH : 0) }
	}

	const top = hint === "blank" ? 0 : hasHeading ? 1.35 : 0.55
	const heading =
		hasHeading && hint !== "blank" ? { x: MARGIN, y: 0.32, w: inner, h: 0.92, align: "left" as const } : undefined

	// Reserve footer space on footered slides.
	const bottom = theme.footer !== undefined ? h - 0.72 : h - 0.42

	const flow: ElementBox[] = []
	let columns: ElementBox[] | undefined
	let y = top

	if (hint === "two-column") {
		const bodies = slide.elements.filter(isBodyElement)
		const others = slide.elements.filter((el) => !isBodyElement(el))
		const colW = inner / 2 - 0.22
		const colEls = bodies.slice(0, 2)
		let colHeights = 0
		columns = colEls.map((el, i) => {
			const eh = estimateElementHeight(el, colW)
			colHeights = Math.max(colHeights, eh)
			return { el, x: MARGIN + i * (inner / 2 + 0.22), y, w: colW, h: eh }
		})
		y += colHeights > 0 ? colHeights + FLOW_GAP : 0
		for (const el of [...(bodies.length > 2 ? bodies.slice(2) : []), ...others]) {
			const eh = estimateElementHeight(el, inner)
			flow.push({ el, x: MARGIN, y, w: inner, h: eh })
			y += eh + FLOW_GAP
		}
	} else {
		for (const el of slide.elements) {
			const eh = estimateElementHeight(el, inner)
			flow.push({
				el,
				x: MARGIN,
				y,
				w: inner,
				h: hint === "chart" && el.type === "chart" ? Math.min(eh, bottom - y) : eh,
			})
			y += flow[flow.length - 1].h + FLOW_GAP
		}
	}

	return { heading, flow, columns, contentBottom: y - FLOW_GAP }
}

/** Estimated content height beyond the region (inches); ≤ 0 fits. */
export function estimateOverflow(slide: SlideSpec, theme: DeckTheme): number {
	const h = theme.slideHeight ?? DEFAULT_SLIDE_H
	const bottom = theme.footer !== undefined ? h - 0.72 : h - 0.42
	const layout = computeSlideLayout(slide, theme)
	return layout.contentBottom - bottom
}
