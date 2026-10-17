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

export const PT_PER_IN = 72

/** Mean glyph width as a fraction of font size (Latin body text, generous). */
const CHAR_WIDTH_RATIO = 0.52

/** Estimated rendered height (pt) of a text block at the given width — shared by the
 * flow estimator and (exported) by interior layouts that center content in stretched boxes. */
export function estimateTextBlockHeightPt(text: string, widthIn: number, fontPt: number): number {
	const charsPerLine = Math.max(4, (widthIn * 72) / (CHAR_WIDTH_RATIO * fontPt))
	const lines = Math.max(1, Math.ceil(text.replace(/`/g, "").length / charsPerLine))
	return lines * fontPt * 1.24
}

export interface Palette {
	bg?: string
	dark: boolean
	accent: string
	text: string
	muted: string
	surface: string
	surface2: string
	/** Card outline on surfaces (theme `line`). */
	border: string
	headFont: string
	bodyFont: string
	monoFont: string
	footer?: string
}

/** Decks are dark-first: an unset background falls to the near-black brand base. */
export const DEFAULT_BACKGROUND = "0E0F13"

export function resolvePalette(theme: DeckTheme): Palette {
	const bg = theme.background !== undefined ? stripHash(theme.background) : DEFAULT_BACKGROUND
	const dark = slideNeedsLightText(bg)
	return {
		bg,
		dark,
		accent: stripHash(theme.accent ?? "00A3A1"),
		text: theme.text !== undefined ? stripHash(theme.text) : dark ? "FFFFFF" : "22262B",
		muted: theme.muted !== undefined ? stripHash(theme.muted) : dark ? "9BA1AB" : "5A6470",
		surface: theme.surface !== undefined ? stripHash(theme.surface) : dark ? "181A21" : "F2F4F6",
		surface2: theme.surface2 !== undefined ? stripHash(theme.surface2) : dark ? "0A0B0E" : "FFFFFF",
		border: theme.line !== undefined ? stripHash(theme.line) : dark ? "2A2E39" : "D8DEE4",
		headFont: theme.headingFont ?? theme.font ?? "Calibri",
		bodyFont: theme.font ?? "Calibri",
		monoFont: theme.monoFont ?? "Courier New",
		footer: theme.footer,
	}
}

/** Mix `hex` toward `target` ("FFFFFF" lightens, "000000" darkens) by fraction `t` (0..1). */
export function mixHex(hex: string, target: string, t: number): string {
	const a = stripHash(hex)
	const b = stripHash(target)
	const mix = (i: number) =>
		Math.round(Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) + Number.parseInt(b.slice(i, i + 2), 16) * t)
	return [mix(0), mix(2), mix(4)].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")
}

/** Monochrome accent ramp for chart series — on-brand by construction. */
export function chartSeriesColors(accent: string, count: number): string[] {
	const base = [accent, mixHex(accent, "FFFFFF", 0.35), mixHex(accent, "000000", 0.3), mixHex(accent, "FFFFFF", 0.62)]
	const out: string[] = []
	for (let i = 0; i < count; i++) out.push(base[i % base.length])
	return out
}

export function inlineTextOf(inline: Inline[]): string {
	return inline.map((i) => i.text).join("")
}

/* ------------------------- height estimation ------------------------- */

function estimatedTextHeightPt(text: string, widthIn: number, fontPt: number): number {
	return estimateTextBlockHeightPt(text, widthIn, fontPt)
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
			const body = estimateTextBlockHeightPt(el.text, widthIn - 1.2, 14.5) / PT_PER_IN
			return Math.max(1.6, body + 0.95)
		}
		case "code":
			return el.lines.length * ((11.5 * 1.3) / PT_PER_IN) + 0.95
		case "cards": {
			const n = el.cards.length
			const cols = n === 3 ? 3 : n <= 2 ? n : n <= 4 ? 2 : 3
			const rows = Math.ceil(n / cols)
			const cardW = (widthIn - 0.3 * (cols - 1)) / cols
			let cardH = 1.35
			for (const c of el.cards) {
				const body = estimatedTextHeightPt(c.body, cardW - 0.55, 11.5) / PT_PER_IN
				cardH = Math.max(cardH, 1.15 + body)
			}
			return rows * cardH + (rows - 1) * 0.3
		}
		case "flow": {
			if (!el.stages.some((st) => st.description !== undefined)) return 1.05
			const n = el.stages.length
			const chipW = Math.max(1, (widthIn - 0.5 * (n - 1)) / n - 0.24)
			const maxDesc = Math.max(
				0,
				...el.stages.map((st) =>
					st.description !== undefined ? estimateTextBlockHeightPt(st.description, chipW, 10.5) : 0,
				),
			)
			return Math.max(1.05, 0.18 + 0.3 + 0.14 + maxDesc / PT_PER_IN + 0.24)
		}
	}
}

/** Chainable: consecutive cards grids collapse to a single grid visually, but keep spacing. */
const isBodyElement = (el: SlideElement) => el.type === "bullets" || el.type === "paragraphs"

/** How much height (inches) each design block may absorb when the slide has slack. */
const STRETCH_CAP: Partial<Record<SlideElement["type"], number>> = {
	stats: 0.9,
	quote: 0.7,
	code: 0.45,
	chart: 1.3,
	flow: 0.35,
	image: 1.0,
	cards: 0.9,
}

export interface ElementBox {
	el: SlideElement
	x: number
	y: number
	w: number
	h: number
}

export interface SlideLayout {
	/** Small caps accent label above the heading (theme-less slot, from a `kicker` fence). */
	kicker?: { x: number; y: number; w: number; h: number }
	heading?: { x: number; y: number; w: number; h: number; align: "left" | "center" }
	flow: ElementBox[]
	/** Column boxes for two-column body elements (kept out of `flow`). */
	columns?: ElementBox[]
	/** Estimated bottom edge of all content (inches). */
	contentBottom: number
}

/**
 * Vertical flow allocation: heading at top, elements stacked in source order,
 * two-column slides get their body blocks split across two columns (other
 * elements still flow full-width below).
 *
 * Canvas-filling: if the natural stack leaves slack above the region bottom,
 * it is absorbed in three phases — stretch design blocks (capped per type),
 * widen inter-row gaps (capped), then shift the flow start down (centering).
 * Whatever remains stays as bottom margin. Content that does not fit is the
 * `slide-overfull` pitfall's concern, not the allocator's.
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
			// Bespoke lockup (renderTitle): kicker, wordmark, subtitle, install card.
			let acc = 1.0 + 2.2
			for (const el of slide.elements) acc += estimateElementHeight(el, inner * 0.9) + FLOW_GAP
			return { heading, flow: [], contentBottom: Math.max(acc, h - 1.05) }
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

	const headingH = hint === "closing" ? 1.35 : 1.0
	const headingY = slide.kicker !== undefined ? 0.68 : 0.32
	const top =
		hint === "blank" ? 0 : hint === "closing" ? 2.05 : hasHeading ? (slide.kicker !== undefined ? 1.72 : 1.35) : 0.55
	const heading =
		hasHeading && hint !== "blank"
			? { x: MARGIN, y: headingY, w: inner, h: headingH, align: "left" as const }
			: undefined
	const kicker = slide.kicker !== undefined && hint !== "blank" ? { x: MARGIN, y: 0.2, w: inner, h: 0.42 } : undefined

	// Reserve footer space on footered slides.
	const bottom = theme.footer !== undefined ? h - 0.72 : h - 0.42

	// Natural-height rows in source order; the two-column pair is one row.
	interface Row {
		el: SlideElement
		h: number
		w: number
		columnPair?: Array<{ el: SlideElement; h: number; w: number }>
	}
	const rows: Row[] = []
	if (hint === "two-column") {
		const bodies = slide.elements.filter(isBodyElement)
		const others = slide.elements.filter((el) => !isBodyElement(el))
		const colW = inner / 2 - 0.22
		const colEls = bodies.slice(0, 2)
		const columnPair = colEls.map((el) => ({ el, h: estimateElementHeight(el, colW), w: colW }))
		const colHeights = Math.max(0, ...columnPair.map((c) => c.h))
		if (columnPair.length > 0) rows.push({ el: columnPair[0].el, h: colHeights, w: inner, columnPair })
		for (const el of [...(bodies.length > 2 ? bodies.slice(2) : []), ...others]) {
			rows.push({ el, h: estimateElementHeight(el, inner), w: inner })
		}
	} else {
		for (const el of slide.elements) {
			rows.push({ el, h: estimateElementHeight(el, inner), w: inner })
		}
	}

	const natural = rows.reduce((sum, r) => sum + r.h, 0) + FLOW_GAP * Math.max(0, rows.length - 1)
	const slack = bottom - top - natural

	// Phase 1 — stretch design blocks, water-filled under per-type caps (total growth per row).
	if (slack > 0.02) {
		let remaining = slack
		const grown = new Map<Row, number>()
		for (let pass = 0; pass < 4 && remaining > 0.02; pass++) {
			const open = rows.filter((r) => (STRETCH_CAP[r.el.type] ?? 0) - (grown.get(r) ?? 0) > 0.01)
			if (open.length === 0) break
			const share = remaining / open.length
			let used = 0
			for (const r of open) {
				const already = grown.get(r) ?? 0
				const grow = Math.min(share, (STRETCH_CAP[r.el.type] ?? 0) - already)
				r.h += grow
				grown.set(r, already + grow)
				used += grow
			}
			if (used <= 0.001) break
			remaining -= used
		}
		// Phase 2 — widen gaps between rows (bounded).
		const extraGap = Math.min(0.3, remaining / Math.max(1, rows.length - 1))
		remaining -= extraGap * Math.max(0, rows.length - 1)
		// Phase 3 — center the rest: shift the flow start down by up to half.
		// Closings are deliberately sparse (statement + links) — let them center
		// harder or the bottom half dies.
		const topShift = Math.min(remaining * 0.5, hint === "closing" ? 1.5 : 0.5)
		let y = top + topShift
		const gap = FLOW_GAP + extraGap
		const flow: ElementBox[] = []
		let columns: ElementBox[] | undefined
		for (const r of rows) {
			if (r.columnPair) {
				columns = r.columnPair.map((c, i) => ({ el: c.el, x: MARGIN + i * (inner / 2 + 0.22), y, w: c.w, h: c.h }))
			} else {
				flow.push({
					el: r.el,
					x: MARGIN,
					y,
					w: r.w,
					h: hint === "chart" && r.el.type === "chart" ? Math.min(r.h, bottom - y) : r.h,
				})
			}
			y += r.h + gap
		}
		return { kicker, heading, flow, columns, contentBottom: y - gap }
	}

	// No slack: plain stacking, exactly the natural heights.
	const flow: ElementBox[] = []
	let columns: ElementBox[] | undefined
	let y = top
	for (const r of rows) {
		if (r.columnPair) {
			columns = r.columnPair.map((c, i) => ({ el: c.el, x: MARGIN + i * (inner / 2 + 0.22), y, w: c.w, h: c.h }))
		} else {
			flow.push({
				el: r.el,
				x: MARGIN,
				y,
				w: r.w,
				h: hint === "chart" && r.el.type === "chart" ? Math.min(r.h, bottom - y) : r.h,
			})
		}
		y += r.h + FLOW_GAP
	}
	return { kicker, heading, flow, columns, contentBottom: y - FLOW_GAP }
}

/** Estimated content height beyond the region (inches); ≤ 0 fits. */
export function estimateOverflow(slide: SlideSpec, theme: DeckTheme): number {
	const h = theme.slideHeight ?? DEFAULT_SLIDE_H
	const bottom = theme.footer !== undefined ? h - 0.72 : h - 0.42
	const layout = computeSlideLayout(slide, theme)
	return layout.contentBottom - bottom
}
