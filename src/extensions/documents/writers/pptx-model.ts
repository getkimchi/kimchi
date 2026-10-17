/** Normalized deck model: what the deck-Markdown parser produces and both
 * the pitfalls guards and the pptxgenjs writer consume. The shape is the
 * contract in deck-markdown.md, not pptxgenjs's API. */

import type { Inline } from "../markdown/blocks.js"

export type LayoutHint = "title" | "hero" | "content" | "two-column" | "table" | "chart" | "closing" | "blank"

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
	/** Big-number callout row (``` stats): value rendered large, label below. */
	| { type: "stats"; entries: Array<{ value: string; label: string }> }
	/** Pull-quote card (```quote); `text | attribution` on the last line splits attribution. */
	| { type: "quote"; text: string; attribution?: string }
	/** Terminal / code card (```code or untyped fence; always dark, mono). */
	| { type: "code"; lines: string[] }
	/** Grid of small cards (```cards); lines are `Title | body`, optional `N.` prefix numbers the card. */
	| { type: "cards"; cards: Array<{ title: string; body: string; number?: string }> }
	/** Horizontal stage flow with arrows (```flow); `*` prefix marks the accent stage;
	 * `Stage | description` adds a sub-line under the label. */
	| { type: "flow"; stages: Array<{ label: string; description?: string; highlight?: boolean }> }

export interface SlideSpec {
	/** 1-based among parsed slides. */
	index: number
	layoutHint?: LayoutHint
	/** Template layout NAME from `inspect` (edit-time append_slide / create --template). */
	layoutName?: string
	heading?: string
	/** Small caps accent label above the heading (```kicker fence). */
	kicker?: string
	background?: string
	elements: SlideElement[]
	/** Speaker-note paragraphs (not rendered on the slide). */
	notes: string[]
}

export interface DeckTheme {
	/** Body font (also used for headings when headingFont is unset). */
	font?: string
	/** Heading font — pairs with the body font for contrast. */
	headingFont?: string
	/** Monospace font for code/terminal cards. */
	monoFont?: string
	/** Brand accent color, hex with or without '#'. */
	accent?: string
	/** Deck-wide background; a dark value flips text/surface defaults. */
	background?: string
	/** Card surface (stats/quote/cards fills). */
	surface?: string
	/** Alternate card surface (quote/footer strip contrast). */
	surface2?: string
	/** Primary text color. */
	text?: string
	/** Secondary text (labels, captions). */
	muted?: string
	/** Card outline on surfaces (theme `line`). */
	line?: string
	/** Footer drawn on content slides; `{n}` = slide number, `{title}` = deck title. */
	footer?: string
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
