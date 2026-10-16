/** Normalized deck model: what the deck-Markdown parser produces and both
 * the pitfalls guards and the pptxgenjs writer consume. The shape is the
 * contract in deck-markdown.md, not pptxgenjs's API. */

import type { Inline } from "../markdown/blocks.js"

export type LayoutHint = "title" | "content" | "two-column" | "table" | "chart" | "blank"

export interface ChartSpec {
	type: "bar" | "line" | "pie" | "doughnut"
	title?: string
	labels: string[]
	series: Array<{ name?: string; values: number[] }>
}

export type SlideElement =
	| { type: "heading"; level: number; inline: Inline[] }
	| { type: "paragraphs"; inline: Inline[][]; notes?: boolean }
	| { type: "bullets"; depth: number; items: Array<{ inline: Inline[]; children: SlideElement[] }> }
	| { type: "table"; header: Inline[][]; rows: Inline[][][] }
	| { type: "chart"; spec: ChartSpec }
	| { type: "image"; path: string; alt: string }

export interface SlideSpec {
	/** 1-based among parsed slides. */
	index: number
	layoutHint?: LayoutHint
	/** Template layout NAME from `inspect` (edit-time append_slide / create --template). */
	layoutName?: string
	heading?: string
	background?: string
	elements: SlideElement[]
	/** Speaker-note paragraphs (not rendered on the slide). */
	notes: string[]
}

export interface DeckTheme {
	font?: string
	accent?: string
	slideWidth?: number
	slideHeight?: number
}

export interface DeckMeta {
	title?: string
	author?: string
}

export interface DeckSpec {
	slides: SlideSpec[]
	theme: DeckTheme
	meta: DeckMeta
	warnings: string[]
}
