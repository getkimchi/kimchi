/**
 * Deck writer: deck Markdown → .pptx bytes via pptxgenjs.
 *
 * Parser half honors the contract in deck-markdown.md: `---` splits slides,
 * read-output locators (`## Slide N`, `[shape "..."]`, `[table N]`, `[chart]`)
 * are accepted and stripped, `Notes:` paragraphs become speaker notes, chart
 * fences become real charts, and unknown syntax is a typed error naming the
 * slide — never dropped content.
 *
 * Writer half maps the DeckSpec onto geometry per layout hint; every guard
 * in writers/pitfalls.ts runs before pptxgenjs is touched. Output is
 * shape-stable, not byte-stable (jszip stamps current-date mtimes).
 */

import { existsSync, statSync } from "node:fs"
import { extname, isAbsolute, normalize } from "node:path"
import JSZip from "jszip"
// pptxgenjs's shipped .d.ts (`export default` a class merged with `export as
// namespace`) isn't constructable under NodeNext import resolution, so the
// default import is cast through the minimal surface this writer uses. The
// bundled output (bun build) and vitest both resolve the same static import.
import pptxgenDefault from "pptxgenjs"
import { type Block, type Inline, parseMarkdownBlocks } from "../markdown/blocks.js"
import { DocumentError } from "../model.js"
import { enforcePitfalls } from "./pitfalls.js"
import {
	chartSeriesColors,
	computeSlideLayout,
	DEFAULT_SLIDE_H,
	DEFAULT_SLIDE_W,
	type ElementBox,
	estimateElementHeight,
	estimateTextBlockHeightPt,
	inlineTextOf,
	MARGIN,
	type Palette,
	PT_PER_IN,
	resolvePalette,
} from "./pptx-layout.js"
import type { ChartSpec, DeckMeta, DeckSpec, DeckTheme, LayoutHint, SlideElement, SlideSpec } from "./pptx-model.js"

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg"])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const LAYOUT_HINTS: LayoutHint[] = ["title", "hero", "content", "two-column", "table", "chart", "closing", "blank"]

export class DeckParseError extends DocumentError {
	constructor(msg: string) {
		super("corrupt", msg, "pptx")
		this.name = "DeckParseError"
	}
}

/** Pull YAML-ish frontmatter (title/author) off the top of the source. */
function parseFrontmatter(markdown: string): { meta: DeckMeta; rest: string } {
	const match = /^---\r?\n((?:.*\r?\n)*?)---\r?\n/.exec(markdown)
	if (!match) return { meta: {}, rest: markdown }
	const meta: DeckMeta = {}
	for (const line of match[1].trim().split(/\r?\n/)) {
		const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line)
		if (!kv) continue
		if (kv[1] === "title") meta.title = kv[2]
		else if (kv[1] === "author") meta.author = kv[2]
	}
	return { meta, rest: markdown.slice(match[0].length) }
}

function inlineText(inline: Inline[]): string {
	return inline.map((i) => i.text).join("")
}

/** Remove `drop` characters from the end of an inline run sequence (for stripping a matched suffix). */
function trimInlineSuffix(inline: Inline[], drop: number): Inline[] {
	const out = inline.map((i) => ({ ...i }))
	let remaining = drop
	for (let i = out.length - 1; i >= 0 && remaining > 0; i--) {
		const text = out[i].text
		if (text.length <= remaining) {
			remaining -= text.length
			out.splice(i, 1)
		} else {
			out[i].text = text.slice(0, text.length - remaining)
			remaining = 0
		}
	}
	return out
}

function headingHint(text: string): { heading: string; hint?: LayoutHint } {
	const match = /^(.*?)\s*::\s*([a-z-]+)\s*$/.exec(text)
	if (!match) return { heading: text }
	const hint = match[2] as LayoutHint
	if (!LAYOUT_HINTS.includes(hint)) {
		throw new DeckParseError(`unknown layout hint "${hint}" — expected one of: ${LAYOUT_HINTS.join(", ")}`)
	}
	return { heading: match[1], hint }
}

const READ_MARKER = /^(\[shape ".*"\]|\[table(\s?\d*)?\]|\[chart\])$/
const SLIDE_LOCATOR = /^Slide \d+$/

function isNotesParagraph(inline: Inline[]): boolean {
	return inline.length > 0 && /^\s*Notes:\s*/.test(inline[0].text)
}

function notesText(inline: Inline[]): string {
	const [first, ...rest] = inline
	return [first.text.replace(/^\s*Notes:\s*/, ""), ...rest.map((i) => i.text)].join("").trim()
}

function parseChartSpec(spec: string, slideIndex: number): ChartSpec {
	let parsed: unknown
	try {
		parsed = JSON.parse(spec)
	} catch {
		throw new DeckParseError(`slide ${slideIndex}: chart block is not valid JSON`)
	}
	const obj = parsed as { type?: string; title?: string; labels?: unknown; series?: unknown }
	if (!["bar", "line", "pie", "doughnut"].includes(obj.type ?? "")) {
		throw new DeckParseError(`slide ${slideIndex}: unknown chart type "${obj.type}" — bar, line, pie or doughnut`)
	}
	if (!Array.isArray(obj.labels)) {
		throw new DeckParseError(`slide ${slideIndex}: chart needs a "labels" array`)
	}
	if (!Array.isArray(obj.series)) {
		throw new DeckParseError(`slide ${slideIndex}: chart needs a "series" array`)
	}
	return {
		type: obj.type as ChartSpec["type"],
		title: obj.title,
		labels: obj.labels.map(String),
		series: (obj.series as Array<{ name?: unknown; values?: unknown }>).map((s) => {
			const raw = Array.isArray(s.values) ? s.values : []
			for (const [vi, v] of raw.entries()) {
				if (typeof v !== "number" || !Number.isFinite(v)) {
					throw new DeckParseError(
						`chart-values-must-be-numeric: series ${String(s.name ?? "(unnamed)")} value ${vi + 1} is ${JSON.stringify(v)}`,
					)
				}
			}
			return {
				name: s.name === undefined ? undefined : String(s.name),
				values: raw as number[],
			}
		}),
	}
}

function parseImage(inline: Inline[]): { path: string; alt: string } | undefined {
	// An image paragraph is exactly one tagged image token (blocks.ts tags
	// them so links — links keep their text only — are unaffected).
	const img = inline.find((i) => i.image === true)
	if (img?.href === undefined || inline.length !== 1) return undefined
	if (/^[a-z]+:/i.test(img.href)) {
		throw new DeckParseError(`image "${img.href}": only local filesystem paths are accepted (no http:/data: URLs)`)
	}
	return { path: img.href, alt: img.text }
}

/** Group a non-list paragraph whose inline contains an image into an image element. */
function paragraphToElement(p: Block & { type: "paragraph" }): SlideElement {
	const image = parseImage(p.inline)
	if (image && inlineText(p.inline).trim() === image.alt.trim()) return { type: "image", ...image }
	return { type: "paragraphs", inline: [p.inline] }
}

function listToBullets(block: Block & { type: "list" }): SlideElement {
	const items = block.items.map((item) => {
		const [first, ...rest] = item
		const inline: Inline[] = first && first.type === "paragraph" ? first.inline : []
		const children: SlideElement[] = []
		for (const sub of rest) {
			if (sub.type === "list") children.push(listToBullets(sub))
		}
		return { inline, children }
	})
	return { type: "bullets", depth: 0, items }
}

/** Split `value | label` once; typed error names the slide and line. */
function splitPair(line: string, slideIndex: number, ctx: string): { first: string; rest: string } {
	const i = line.indexOf("|")
	if (i < 0) throw new DeckParseError(`slide ${slideIndex}: ${ctx} line needs "value | label": ${line}`)
	return { first: line.slice(0, i).trim(), rest: line.slice(i + 1).trim() }
}

function parseStatsBlock(code: string, slideIndex: number): SlideElement {
	const entries = code
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const { first, rest } = splitPair(l, slideIndex, "stats")
			return { value: first, label: rest }
		})
	if (entries.length === 0) throw new DeckParseError(`slide ${slideIndex}: "stats" block is empty`)
	return { type: "stats", entries }
}

function parseQuoteBlock(code: string, slideIndex: number): SlideElement {
	const lines = code.split(/\r?\n/).filter((l) => l.trim())
	if (lines.length === 0) throw new DeckParseError(`slide ${slideIndex}: "quote" block is empty`)
	let attribution: string | undefined
	const last = lines[lines.length - 1]
	if (last.trim().startsWith("|")) {
		attribution = last.replace(/^\s*\|\s*/, "").trim()
		lines.pop()
	}
	const text = lines.join("\n").trim()
	if (!text) throw new DeckParseError(`slide ${slideIndex}: "quote" has attribution but no quote text`)
	return { type: "quote", text, attribution }
}

function parseCardsBlock(code: string, slideIndex: number): SlideElement {
	const cards = code
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			const num = /^(\d+)\.\s+/.exec(l)
			const body = num ? l.slice(num[0].length) : l
			const { first, rest } = splitPair(body, slideIndex, "cards")
			return { title: first, body: rest, number: num ? num[1] : undefined }
		})
	if (cards.length === 0) throw new DeckParseError(`slide ${slideIndex}: "cards" block is empty`)
	return { type: "cards", cards }
}

function parseFlowBlock(code: string, slideIndex: number): SlideElement {
	const raw = code
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)
	const pieces = raw.length === 1 && raw[0].includes("→") ? raw[0].split("→") : raw
	const stages = pieces
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => {
			let label = p
			let description: string | undefined
			if (p.includes("|")) {
				const { first, rest } = splitPair(p, slideIndex, "flow")
				label = first
				description = rest
			}
			return label.startsWith("*")
				? { label: label.slice(1).trim(), description, highlight: true }
				: { label: label.trim(), description }
		})
	if (stages.length < 2) throw new DeckParseError(`slide ${slideIndex}: "flow" needs at least two stages`)
	return { type: "flow", stages }
}

/** Map a fenced block to a design element: typed languages first, anything else is a terminal/code card. */
function fencedBlockToElement(block: Block & { type: "code" }, slideIndex: number): SlideElement {
	switch (block.lang) {
		case "stats":
			return parseStatsBlock(block.code, slideIndex)
		case "quote":
			return parseQuoteBlock(block.code, slideIndex)
		case "cards":
			return parseCardsBlock(block.code, slideIndex)
		case "flow":
			return parseFlowBlock(block.code, slideIndex)
		case "code":
		case undefined:
			return { type: "code", lines: block.code.split(/\r?\n/) }
		default:
			throw new DeckParseError(
				`slide ${slideIndex}: unknown block type "${block.lang}" — supported: chart, stats, quote, cards, flow, code (or untyped fences for code)`,
			)
	}
}

/** Strip read-output locator lines, returning the blocks that carry content. */
function stripReadMarkers(blocks: Block[]): Block[] {
	const out: Block[] = []
	for (const b of blocks) {
		if (b.type === "paragraph") {
			const text = b.inline.map((i) => i.text).join("")
			if (READ_MARKER.test(text.trim())) continue
			// Read output packs a locator line and its text into one single-part
			// paragraph (`[shape "Title 1"]\nbullet text`). Rebuild ONLY those,
			// dropping locator lines; any other paragraph passes through with its
			// inline flags (bold/image/href) untouched.
			const lines = text.split("\n")
			if (!lines.some((line) => READ_MARKER.test(line.trim()))) {
				out.push(b)
				continue
			}
			const kept = lines.filter((line) => !READ_MARKER.test(line.trim()))
			if (kept.length === 0 || kept.join("\n").trim() === "") continue
			out.push({ type: "paragraph", inline: [{ text: kept.join("\n") }] })
			continue
		}
		if (b.type === "heading") {
			if (SLIDE_LOCATOR.test(inlineText(b.inline).trim())) continue
		}
		out.push(b)
	}
	return out
}

export function parseDeckMarkdown(markdown: string, theme: DeckTheme = {}, warnings: string[] = []): DeckSpec {
	const { meta, rest } = parseFrontmatter(markdown)
	const blocks = parseMarkdownBlocks(rest)
	const slides: SlideSpec[] = []

	const groups: Block[][] = [[]]
	for (const block of stripReadMarkers(blocks)) {
		if (block.type === "pagebreak") groups.push([])
		else groups[groups.length - 1].push(block)
	}

	for (const group of groups) {
		const slide: SlideSpec = { index: 0, elements: [], notes: [] }
		let seenContent = false
		for (const block of group) {
			if (block.type === "heading" && block.level === 1) {
				const { heading, hint } = headingHint(inlineText(block.inline))
				slide.heading = heading
				if (hint) slide.layoutHint = hint
				seenContent = true
				continue
			}
			if (block.type === "paragraph" && isNotesParagraph(block.inline)) {
				slide.notes.push(notesText(block.inline))
				seenContent = true
				continue
			}
			if (block.type === "chart") {
				slide.elements.push({ type: "chart", spec: parseChartSpec(block.spec, groups.indexOf(group) + 1) })
				seenContent = true
				continue
			}
			if (block.type === "paragraph") {
				slide.elements.push(paragraphToElement(block))
				seenContent = true
				continue
			}
			if (block.type === "list") {
				slide.elements.push(listToBullets(block))
				seenContent = true
				continue
			}
			if (block.type === "heading") {
				// A `:: hint` suffix works on any heading level; on sub-headings it
				// sets the slide's layout and is stripped from the rendered text.
				// Unknown ":: whatever" text is left alone — it's prose, not a hint.
				let inline = block.inline
				const full = inlineText(block.inline)
				const match = /^(.*?)\s*::\s*([a-z-]+)\s*$/.exec(full)
				if (match && LAYOUT_HINTS.includes(match[2] as LayoutHint)) {
					if (slide.layoutHint === undefined) slide.layoutHint = match[2] as LayoutHint
					const drop = full.length - match[1].length
					inline = trimInlineSuffix(block.inline, drop)
				}
				slide.elements.push({ type: "heading", level: block.level, inline })
				seenContent = true
				continue
			}
			if (block.type === "table") {
				slide.elements.push({ type: "table", header: block.header, rows: block.rows })
				seenContent = true
				continue
			}
			if (block.type === "code" && block.lang === "kicker") {
				const text = block.code.trim().split(/\r?\n/)[0].trim()
				if (!text) throw new DeckParseError(`slide ${groups.indexOf(group) + 1}: "kicker" block is empty`)
				slide.kicker = text
				seenContent = true
				continue
			}
			if (block.type === "code") {
				slide.elements.push(fencedBlockToElement(block, groups.indexOf(group) + 1))
				seenContent = true
				continue
			}
			if (block.type === "blockquote" || block.type === "hr" || block.type === "image") {
				seenContent = true
			}
		}
		if (seenContent) {
			slide.index = slides.length + 1
			slides.push(slide)
		}
	}

	if (slides.length === 0) {
		throw new DeckParseError("no slides — the deck Markdown has only frontmatter, locators, or splitters")
	}
	return { slides, theme, meta, warnings }
}

/* ------------------------------ writer half ------------------------------ */

function pptxRunFromInline(
	inline: Inline[],
	color?: string,
): Array<{ text: string; options: Record<string, unknown> }> {
	return inline.map((i) => ({
		text: i.text,
		options: {
			bold: !!i.bold,
			italic: !!i.italic,
			...(i.code ? { fontFace: "Courier New" } : {}),
			...(color ? { color } : {}),
		},
	}))
}

/** Minimal typed surface of pptxgenjs this writer uses (see the import note). */
interface PptxSlide {
	addText(text: string | Array<{ text: string; options: Record<string, unknown> }>, opts: Record<string, unknown>): void
	addTable(rows: unknown[][], opts: Record<string, unknown>): void
	addChart(type: unknown, data: unknown[], opts: Record<string, unknown>): void
	addImage(opts: Record<string, unknown>): void
	addShape(shape: string, opts: Record<string, unknown>): void
	addNotes(notes: unknown): void
	background?: { color: string }
}

interface PptxInstance {
	layout: string
	title: string
	author: string
	theme: Record<string, string>
	ChartType: Record<string, unknown>
	defineLayout(layout: { name: string; width: number; height: number }): void
	addSlide(): PptxSlide
	write(opts: { outputType: "nodebuffer" }): Promise<Buffer>
}

const PptxGenJS = pptxgenDefault as unknown as new () => PptxInstance

export interface WriteOptions {
	/** Base directory for resolving relative image paths. */
	baseDir?: string
	/** File existence/read hooks (tests inject; CLI uses defaults). */
	fileExists?: (path: string) => boolean
	fileSize?: (path: string) => number
}

function checkImage(path: string, slide: SlideSpec, options: WriteOptions): void {
	const exists = options.fileExists ?? existsSync
	const size = options.fileSize ?? ((p: string) => statSync(p).size)
	const ext = extname(path).toLowerCase()
	if (!IMAGE_EXTS.has(ext)) {
		throw new DocumentError(
			"unsupported-format",
			`slide ${slide.index}: image "${path}" is not PNG/JPEG (local files only)`,
		)
	}
	if (!exists(path)) {
		throw new DocumentError("corrupt", `slide ${slide.index}: image not found: ${path}`)
	}
	if (size(path) > MAX_IMAGE_BYTES) {
		throw new DocumentError("too-large", `slide ${slide.index}: image "${path}" exceeds the 20 MB cap`)
	}
}

function flattenBullets(el: SlideElement & { type: "bullets" }, color: string) {
	const out: Array<{ text: string; options: Record<string, unknown> }> = []
	const walk = (items: typeof el.items, depth: number) => {
		for (const item of items) {
			const text = item.inline.map((i) => i.text).join("")
			out.push({
				text,
				options: {
					bullet: { indent: 12 + depth * 18 },
					breakLine: true,
					...(item.inline.some((i) => i.bold) ? { bold: true } : {}),
					...(item.inline.some((i) => i.italic) ? { italic: true } : {}),
					color,
				},
			})
			for (const child of item.children) {
				if (child.type === "bullets") walk(child.items, depth + 1)
			}
		}
	}
	walk(el.items, el.depth)
	return out
}

/* ------------------------- element renderers ------------------------- */

/** Terminal cards are always dark, light or dark theme alike. */
const TERMINAL = { fill: "0A0B0E", text: "C8CDD6", prompt: "7BD88F", comment: "8B93A0" }

function addCard(
	s: PptxSlide,
	box: { x: number; y: number; w: number; h: number },
	fill: string,
	border: string,
): void {
	s.addShape("roundRect", { ...box, rectRadius: 0.08, fill: { color: fill }, line: { color: border, width: 0.75 } })
}

function textRuns(paragraphs: Inline[][], color: string) {
	// Break runs only BETWEEN paragraphs — a trailing break run has no color of
	// its own, and pptxgenjs materializes it as an explicit black run (which the
	// low-contrast check then flags on dark decks).
	return paragraphs.flatMap((p, i) => [
		...pptxRunFromInline(p, color),
		...(i < paragraphs.length - 1 ? [{ text: "\n", options: { breakLine: true } }] : []),
	])
}

function renderElement(
	s: PptxSlide,
	pptx: PptxInstance,
	box: ElementBox,
	pal: Palette,
	options: WriteOptions,
	slideIndex: number,
	renderOpts?: { large?: boolean },
): void {
	const el = box.el
	const bodyScale = renderOpts?.large === true ? 1.12 : 1
	const listSpacing = renderOpts?.large === true ? 1.4 : undefined
	switch (el.type) {
		case "heading":
			s.addText(inlineText(el.inline), {
				x: box.x,
				y: box.y,
				w: box.w,
				h: box.h,
				isTextBox: true,
				margin: 0,
				fontFace: pal.headFont,
				fontSize: 20,
				bold: true,
				color: pal.text,
			})
			break
		case "paragraphs":
			s.addText(textRuns(el.inline, pal.text), {
				x: box.x,
				y: box.y,
				w: box.w,
				h: box.h,
				isTextBox: true,
				margin: 0,
				fontFace: pal.bodyFont,
				fontSize: 16 * bodyScale,
				lineSpacingMultiple: listSpacing ?? 1.2,
			})
			break
		case "bullets":
			s.addText(flattenBullets(el, pal.text), {
				x: box.x,
				y: box.y,
				w: box.w,
				h: box.h,
				isTextBox: true,
				margin: 0,
				fontFace: pal.bodyFont,
				fontSize: 16 * bodyScale,
				lineSpacingMultiple: listSpacing ?? 1.25,
			})
			break
		case "table":
			s.addTable(
				[
					el.header.map((cell) => ({
						text: inlineTextOf(cell),
						options: { bold: true, fill: { color: pal.accent }, color: "FFFFFF" },
					})),
					...el.rows.map((row) => row.map((cell) => inlineTextOf(cell))),
				],
				{
					x: box.x,
					y: box.y,
					w: box.w,
					fontFace: pal.bodyFont,
					fontSize: 14,
					border: { pt: 1, color: pal.border },
					color: pal.text,
				},
			)
			break
		case "chart": {
			const chartType =
				el.spec.type === "bar"
					? pptx.ChartType.bar
					: el.spec.type === "line"
						? pptx.ChartType.line
						: el.spec.type === "pie"
							? pptx.ChartType.pie
							: pptx.ChartType.doughnut
			s.addChart(
				chartType,
				el.spec.series.map((srs, i) => ({
					name: srs.name ?? `Series ${i + 1}`,
					labels: el.spec.labels,
					values: srs.values,
				})),
				{
					x: box.x,
					y: box.y,
					w: box.w,
					h: box.h,
					chartTitle: el.spec.title,
					chartColors: chartSeriesColors(pal.accent, el.spec.series.length),
					showValue: el.spec.type === "bar" ? true : undefined,
					dataLabelColor: pal.text,
					dataLabelFontSize: 10,
					dataLabelFontFace: pal.bodyFont,
					dataLabelFormatCode: "0.##",
					showLegend: el.spec.series.length > 1,
					catAxisLabelColor: pal.muted,
					valAxisLabelColor: pal.muted,
					valGridLine: { color: pal.border, size: 0.5 },
					catGridLine: { style: "none" },
				},
			)
			break
		}
		case "image": {
			// The documented contract: relative paths under the deck's Markdown
			// dir. Absolute paths and `..` escapes are rejected so a hostile deck
			// cannot embed arbitrary local files.
			if (isAbsolute(el.path) || el.path.split(/[\\/]/).includes("..")) {
				throw new DocumentError(
					"unsupported-format",
					`slide ${slideIndex}: image path "${el.path}" must stay under the deck's directory`,
				)
			}
			const path = normalize(`${options.baseDir ?? "."}/${el.path}`)
			checkImage(path, { index: slideIndex, elements: [el], notes: [] }, options)
			s.addImage({
				path,
				x: box.x,
				y: box.y,
				w: box.w,
				h: box.h,
				alt: el.alt,
				sizing: { type: "contain", w: box.w, h: box.h },
			})
			break
		}
		case "stats": {
			const n = el.entries.length
			const gap = 0.45
			const cw = (box.w - gap * (n - 1)) / n
			el.entries.forEach((entry, i) => {
				const cx = box.x + i * (cw + gap)
				addCard(s, { x: cx, y: box.y, w: cw, h: box.h }, pal.surface, pal.border)
				s.addText(entry.value, {
					x: cx + 0.22,
					y: box.y + 0.14,
					w: cw - 0.44,
					h: 0.72,
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: pal.headFont,
					fontSize: 34,
					bold: true,
					color: pal.accent,
				})
				s.addText(entry.label, {
					x: cx + 0.22,
					y: box.y + 0.92,
					w: cw - 0.44,
					h: box.h - 1.05,
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: pal.bodyFont,
					fontSize: 11.5,
					color: pal.muted,
					lineSpacingMultiple: 1.12,
				})
			})
			break
		}
		case "quote": {
			addCard(s, box, pal.surface2, pal.border)
			s.addText("\u201C", {
				x: box.x + 0.18,
				y: box.y + 0.02,
				w: 0.75,
				h: 1.1,
				isTextBox: true,
				margin: 0,
				fontFace: "Cambria",
				fontSize: 52,
				bold: true,
				color: pal.accent,
			})
			const hasAttr = !!el.attribution
			s.addText(el.text, {
				x: box.x + 1.0,
				y: box.y + 0.22,
				w: hasAttr ? box.w * 0.6 : box.w - 1.35,
				h: box.h - 0.55,
				isTextBox: true,
				margin: 0,
				fit: "shrink",
				fontFace: pal.bodyFont,
				fontSize: 14.5,
				italic: true,
				color: pal.text,
				lineSpacingMultiple: 1.18,
			})
			if (el.attribution) {
				s.addText(el.attribution, {
					x: box.x + box.w * 0.66,
					y: box.y + box.h - 1.0,
					w: box.w * 0.28,
					h: 0.75,
					isTextBox: true,
					margin: 0,
					fontFace: pal.bodyFont,
					fontSize: 12,
					bold: true,
					color: pal.accent,
					align: "right",
					lineSpacingMultiple: 1.15,
				})
			}
			break
		}
		case "code": {
			addCard(s, box, TERMINAL.fill, pal.border)
			// Traffic-light dots on the header strip — the terminal cue.
			;["FF5F57", "FEBC2E", "28C840"].forEach((c, i) => {
				s.addShape("ellipse", { x: box.x + 0.16 + i * 0.22, y: box.y + 0.14, w: 0.14, h: 0.14, fill: { color: c } })
			})
			const runs = el.lines.map((line, i) => ({
				text: line,
				options: {
					breakLine: i < el.lines.length - 1,
					color: /^\s*[$>]/.test(line) ? TERMINAL.prompt : /^\s*#/.test(line) ? TERMINAL.comment : TERMINAL.text,
				},
			}))
			s.addText(runs, {
				x: box.x + 0.24,
				y: box.y + 0.42,
				w: box.w - 0.48,
				h: box.h - 0.55,
				isTextBox: true,
				margin: 0,
				fontFace: pal.monoFont,
				fontSize: 11.5,
				lineSpacingMultiple: 1.28,
				valign: "middle",
			})
			break
		}
		case "cards": {
			const n = el.cards.length
			const cols = n === 3 ? 3 : n <= 2 ? n : n <= 4 ? 2 : 3
			const rows = Math.ceil(n / cols)
			const gap = 0.3
			const cw = (box.w - gap * (cols - 1)) / cols
			const ch = (box.h - gap * (rows - 1)) / rows
			// Type scales with the (possibly stretched) card and the title+body
			// group centers vertically — growth reads as padding, not emptiness.
			const big = ch > 1.75
			const titleSize = big ? 17 : 15.5
			const bodySize = big ? 12.5 : 11.5
			const titleH = 0.42
			el.cards.forEach((card, i) => {
				const cx = box.x + (i % cols) * (cw + gap)
				const cy = box.y + Math.floor(i / cols) * (ch + gap)
				addCard(s, { x: cx, y: cy, w: cw, h: ch }, pal.surface, pal.border)
				let tx = cx + 0.22
				if (card.number) {
					s.addShape("ellipse", { x: cx + 0.2, y: cy + 0.2, w: 0.4, h: 0.4, fill: { color: pal.accent } })
					s.addText(card.number, {
						x: cx + 0.2,
						y: cy + 0.2,
						w: 0.4,
						h: 0.4,
						isTextBox: true,
						margin: 0,
						fontFace: pal.headFont,
						fontSize: 13,
						bold: true,
						color: "FFFFFF",
						align: "center",
						valign: "middle",
					})
					tx = cx + 0.72
				}
				const bodyPt = estimateTextBlockHeightPt(card.body, cx + cw - tx - 0.2, bodySize)
				const contentH = titleH + 0.12 + bodyPt / PT_PER_IN
				// Badge clearance is horizontal (tx starts right of it), never vertical.
				const titleTop = Math.min(Math.max((ch - contentH) / 2, 0.16), Math.max(0.16, ch - contentH - 0.14))
				s.addText(card.title, {
					x: tx,
					y: cy + titleTop,
					w: cx + cw - tx - 0.2,
					h: titleH,
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: pal.headFont,
					fontSize: titleSize,
					bold: true,
					color: pal.text,
				})
				s.addText(card.body, {
					x: tx,
					y: cy + titleTop + titleH + 0.12,
					w: cx + cw - tx - 0.2,
					h: Math.max(0.3, ch - titleTop - titleH - 0.26),
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: pal.bodyFont,
					fontSize: bodySize,
					color: pal.muted,
					lineSpacingMultiple: 1.16,
				})
			})
			break
		}
		case "flow": {
			const n = el.stages.length
			const arrowW = 0.5
			const bw = (box.w - arrowW * (n - 1)) / n
			const hasDesc = el.stages.some((st) => st.description !== undefined)
			el.stages.forEach((stage, i) => {
				const bx = box.x + i * (bw + arrowW)
				const fill = stage.highlight ? pal.accent : pal.surface
				const chip = { x: bx, y: box.y + 0.05, w: bw, h: box.h - 0.1 }
				addCard(s, chip, fill, pal.border)
				if (hasDesc) {
					// Two-line chip: mono label over a muted sub-description. The label
					// font shrinks to guarantee a single line — `fit: shrink` saves
					// PowerPoint rendering but the static check counts real lines.
					const labelSize = Math.max(9.5, Math.min(13.5, (bw - 0.24 - 14.4) / (0.5 * Math.max(1, stage.label.length))))
					s.addText(stage.label, {
						x: bx + 0.12,
						y: chip.y + 0.16,
						w: bw - 0.24,
						h: 0.34,
						isTextBox: true,
						margin: 0,
						fit: "shrink",
						fontFace: pal.monoFont,
						fontSize: labelSize,
						bold: true,
						color: stage.highlight ? "FFFFFF" : pal.text,
					})
					if (stage.description !== undefined) {
						s.addText(stage.description, {
							x: bx + 0.12,
							y: chip.y + 0.54,
							w: bw - 0.24,
							h: chip.h - 0.68,
							isTextBox: true,
							margin: 0,
							fit: "shrink",
							fontFace: pal.bodyFont,
							fontSize: 10.5,
							color: stage.highlight ? "FFFFFF" : pal.muted,
							lineSpacingMultiple: 1.15,
						})
					}
				} else {
					s.addText(stage.label, {
						x: bx,
						y: chip.y,
						w: bw,
						h: chip.h,
						isTextBox: true,
						margin: 0,
						fit: "shrink",
						fontFace: pal.monoFont,
						fontSize: 14,
						bold: true,
						color: stage.highlight ? "FFFFFF" : pal.text,
						align: "center",
						valign: "middle",
					})
				}
				if (i < n - 1) {
					s.addText("→", {
						x: bx + bw,
						y: box.y + box.h / 2 - 0.35,
						w: arrowW,
						h: 0.7,
						isTextBox: true,
						margin: 0,
						fontFace: pal.headFont,
						fontSize: 22,
						bold: true,
						color: pal.accent,
						align: "center",
						valign: "middle",
					})
				}
			})
			break
		}
	}
}

/** Closing list: pillar rows (bold term + muted rest) with the last item pinned as an accent link row. */
function renderClosingList(s: PptxSlide, box: ElementBox, pal: Palette, slideH: number): void {
	const el = box.el
	if (el.type !== "bullets") {
		return
	}
	const items = el.items.filter((it) => it.children.length === 0).map((it) => inlineTextOf(it.inline))
	if (items.length === 0) {
		return
	}
	const links = items.length > 1 ? items[items.length - 1] : undefined
	const pillars = links !== undefined ? items.slice(0, -1) : items
	const runs: Array<{ text: string; options: Record<string, unknown> }> = []
	pillars.forEach((text, i) => {
		const sep = text.indexOf(" — ")
		const last = i < pillars.length - 1
		if (sep > 0) {
			runs.push({ text: text.slice(0, sep), options: { bold: true, color: pal.text } })
			runs.push({ text: text.slice(sep), options: { color: pal.muted, breakLine: last } })
		} else {
			runs.push({ text, options: { color: pal.text, breakLine: last } })
		}
	})
	s.addText(runs, {
		x: box.x,
		y: box.y,
		w: box.w,
		h: Math.max(0.5, slideH - 1.15 - box.y),
		isTextBox: true,
		margin: 0,
		fontFace: pal.bodyFont,
		fontSize: 16.5,
		lineSpacingMultiple: 1.45,
		valign: "top",
	})
	if (links !== undefined) {
		s.addText(links, {
			x: box.x,
			y: slideH - 0.85,
			w: box.w,
			h: 0.4,
			isTextBox: true,
			margin: 0,
			fontFace: pal.bodyFont,
			fontSize: 13.5,
			bold: true,
			color: pal.accent,
		})
	}
}

/** Title slide lockup: corner glow, kicker, big left wordmark, muted subtitle, optional install terminal card. */
function renderTitle(
	s: PptxSlide,
	pptx: PptxInstance,
	slide: SlideSpec,
	pal: Palette,
	options: WriteOptions,
	w: number,
	h: number,
): void {
	const inner = w - 2 * MARGIN
	// Corner glow — kept fully in-bounds so `check` stays clean (transparency, not a gradient).
	s.addShape("ellipse", {
		x: w - 4.6,
		y: 0.25,
		w: 4.4,
		h: 4.4,
		fill: { color: pal.accent, transparency: 90 },
		line: { type: "none" },
	})
	if (slide.kicker !== undefined) {
		s.addText(slide.kicker.toUpperCase(), {
			x: MARGIN,
			y: 0.55,
			w: inner,
			h: 0.42,
			isTextBox: true,
			margin: 0,
			fontFace: pal.headFont,
			fontSize: 10.5,
			bold: true,
			charSpacing: 3,
			color: pal.accent,
		})
	}
	if (slide.heading !== undefined) {
		s.addText(slide.heading, {
			x: MARGIN,
			y: 1.05,
			w: inner * 0.9,
			h: 2.25,
			isTextBox: true,
			margin: 0,
			fit: "shrink",
			fontFace: pal.headFont,
			fontSize: 54,
			bold: true,
			color: pal.text,
		})
	}
	let y = 3.55
	let sawSubtitle = false
	for (const el of slide.elements) {
		if (el.type === "code") continue // pinned install card below
		const eh = estimateElementHeight(el, inner * 0.78)
		if (el.type === "paragraphs" && !sawSubtitle) {
			sawSubtitle = true
			s.addText(textRuns(el.inline, pal.muted), {
				x: MARGIN,
				y,
				w: inner * 0.78,
				h: eh,
				isTextBox: true,
				margin: 0,
				fontFace: pal.bodyFont,
				fontSize: 15.5,
				lineSpacingMultiple: 1.15,
			})
		} else {
			renderElement(s, pptx, { el, x: MARGIN, y, w: inner * 0.78, h: eh }, pal, options, slide.index)
		}
		y += eh + 0.3
	}
	const code = slide.elements.find((e) => e.type === "code")
	if (code?.type === "code") {
		const cardH = Math.min(estimateElementHeight(code, 7.4), 2.2)
		renderElement(s, pptx, { el: code, x: MARGIN, y: h - cardH - 0.5, w: 7.4, h: cardH }, pal, options, slide.index)
	}
}

/** Hero slide: brand title layout — big heading, accent tagline, optional terminal card, link row. */
function renderHero(s: PptxSlide, pptx: PptxInstance, slide: SlideSpec, pal: Palette, w: number, h: number): void {
	const inner = w - 2 * MARGIN
	// Corner glow: kept fully in-bounds so `check` stays clean (transparency, not a gradient).
	s.addShape("ellipse", {
		x: w - 4.4,
		y: h - 4.4,
		w: 4.4,
		h: 4.4,
		fill: { color: pal.accent, transparency: 88 },
		line: { type: "none" },
	})
	if (slide.heading !== undefined) {
		s.addText(slide.heading, {
			x: MARGIN,
			y: 1.35,
			w: inner,
			h: 1.9,
			isTextBox: true,
			margin: 0,
			fit: "shrink",
			fontFace: pal.headFont,
			fontSize: 54,
			bold: true,
			color: pal.text,
		})
	}
	let firstPara = true
	let y = 3.4
	for (const el of slide.elements) {
		if (el.type === "paragraphs") {
			for (const p of el.inline) {
				const lines = Math.max(1, Math.ceil(inlineTextOf(p).length / 90))
				const ph = lines * (firstPara ? 0.48 : 0.32)
				s.addText(pptxRunFromInline(p, firstPara ? pal.accent : pal.muted), {
					x: MARGIN,
					y,
					w: firstPara ? inner : inner * 0.72,
					h: ph + 0.1,
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: firstPara ? pal.headFont : pal.bodyFont,
					fontSize: firstPara ? 22 : 13.5,
					bold: firstPara,
					lineSpacingMultiple: 1.15,
				})
				y += ph + 0.16
				firstPara = false
			}
		}
	}
	for (const el of slide.elements) {
		if (el.type === "code") {
			const ch = Math.min(estimateElementHeight(el, 7.0), 2.3)
			renderElement(
				s,
				pptx,
				{ el, x: MARGIN, y: Math.min(y + 0.15, h - 1.05 - ch), w: 7.6, h: ch },
				pal,
				{},
				slide.index,
			)
		}
	}
	for (const el of slide.elements) {
		if (el.type === "bullets") {
			const links = flattenBullets(el, pal.muted)
				.map((r) => r.text)
				.join("   ·   ")
			s.addText(links, {
				x: MARGIN,
				y: h - 0.62,
				w: inner,
				h: 0.35,
				isTextBox: true,
				margin: 0,
				fit: "shrink",
				fontFace: pal.bodyFont,
				fontSize: 11.5,
				color: pal.muted,
			})
		}
	}
}

function expandFooter(template: string, n: number, title: string | undefined): string {
	return template.replaceAll("{n}", String(n)).replaceAll("{title}", title ?? "")
}

export async function writePptx(spec: DeckSpec, options: WriteOptions = {}): Promise<Uint8Array> {
	enforcePitfalls(spec.slides, spec.theme)

	const theme = spec.theme
	const w = theme.slideWidth ?? DEFAULT_SLIDE_W
	const h = theme.slideHeight ?? DEFAULT_SLIDE_H
	const basePal = resolvePalette(theme)
	const pptx: PptxInstance = new PptxGenJS()
	pptx.defineLayout({ name: "KIMCHI", width: w, height: h })
	pptx.layout = "KIMCHI"
	if (spec.meta.title) pptx.title = spec.meta.title
	if (spec.meta.author) pptx.author = spec.meta.author
	pptx.theme = { headFontFace: basePal.headFont, bodyFontFace: basePal.bodyFont }

	for (const slide of spec.slides) {
		// A per-slide background override re-derives text/surface colors for it.
		const pal = slide.background ? resolvePalette({ ...theme, background: slide.background }) : basePal
		const s = pptx.addSlide()
		if (pal.bg) s.background = { color: pal.bg }

		if (slide.layoutHint === "hero") {
			renderHero(s, pptx, slide, pal, w, h)
		} else if (slide.layoutHint === "title") {
			renderTitle(s, pptx, slide, pal, options, w, h)
		} else {
			const layout = computeSlideLayout(slide, theme)
			if (slide.layoutHint === "closing") {
				// Corner glow — same motif as title/hero, so the bookends read as one family.
				s.addShape("ellipse", {
					x: w - 4.6,
					y: h - 4.6,
					w: 4.4,
					h: 4.4,
					fill: { color: pal.accent, transparency: 90 },
					line: { type: "none" },
				})
			}
			if (layout.kicker && slide.kicker !== undefined) {
				s.addText(slide.kicker.toUpperCase(), {
					x: layout.kicker.x,
					y: layout.kicker.y,
					w: layout.kicker.w,
					h: layout.kicker.h,
					isTextBox: true,
					margin: 0,
					fontFace: pal.headFont,
					fontSize: 10.5,
					bold: true,
					charSpacing: 3,
					color: pal.accent,
				})
			}
			if (layout.heading && slide.heading !== undefined) {
				s.addText(slide.heading, {
					x: layout.heading.x,
					y: layout.heading.y,
					w: layout.heading.w,
					h: layout.heading.h,
					isTextBox: true,
					margin: 0,
					fit: "shrink",
					fontFace: pal.headFont,
					fontSize: slide.layoutHint === "closing" ? 40 : 32,
					bold: true,
					color: pal.text,
				})
			}
			const renderOpts = slide.layoutHint === "closing" ? { large: true } : undefined
			for (const col of layout.columns ?? []) renderElement(s, pptx, col, pal, options, slide.index, renderOpts)
			for (const box of layout.flow) {
				if (renderOpts !== undefined && box.el.type === "bullets") {
					renderClosingList(s, box, pal, h)
				} else {
					renderElement(s, pptx, box, pal, options, slide.index, renderOpts)
				}
			}
		}

		// Footer on workhorse slides only — clean title/hero/closing faces.
		if (
			pal.footer &&
			slide.layoutHint !== "title" &&
			slide.layoutHint !== "hero" &&
			slide.layoutHint !== "closing" &&
			slide.layoutHint !== "blank"
		) {
			s.addText(expandFooter(pal.footer, slide.index, spec.meta.title), {
				x: w - 3.6,
				y: h - 0.44,
				w: 3.0,
				h: 0.3,
				isTextBox: true,
				margin: 0,
				fontFace: pal.bodyFont,
				fontSize: 9,
				color: pal.muted,
				align: "right",
			})
		}

		if (slide.notes.length > 0) s.addNotes(slide.notes.join("\n"))
	}

	/**
	 * Keynote compatibility sanitizer. PowerPoint and LibreOffice open decks
	 * that Keynote refuses or flags with an import warning; four known deltas:
	 *  1. pptxgenjs declares a Content_Types Override for `slideMaster{N}` per
	 *     slide but only writes slideMaster1 — orphan Overrides Keynote rejects.
	 *  2. `p:bgPr` ships without the `<a:effectLst/>` child PowerPoint always
	 *     writes; Keynote's background parser wants it.
	 *  3. `chart1.xml` keeps a dangling third `<c:axId>` (bar charts define two
	 *     axes) and omits the `<c:lang/>` boilerplate.
	 *  4. `p:sldSz cx` lands on a non-canonical width (13.33in × 914400) —
	 *     snapped to the canonical 16:9 value like PowerPoint Online does.
	 * All fixes are idempotent and content-safe.
	 */
	async function sanitizeForExport(bytes: Uint8Array): Promise<Uint8Array> {
		const zip = await JSZip.loadAsync(bytes)
		const partNames = new Set(Object.keys(zip.files).map((name) => (name.startsWith("/") ? name : `/${name}`)))

		// 1. orphan Content_Types Overrides
		const typesFile = zip.file("[Content_Types].xml")
		if (!typesFile) return bytes
		let types = await typesFile.async("string")
		types = types.replace(/<Override PartName="([^"]+)"[^>]*\/>/g, (entry, partName: string) =>
			partNames.has(partName) ? entry : "",
		)
		zip.file("[Content_Types].xml", types)

		// 2. sldSz: snap near-canonical widescreen to the canonical EMU values
		const presFile = zip.file("ppt/presentation.xml")
		if (presFile) {
			let pres = await presFile.async("string")
			pres = pres.replace(/<p:sldSz [^>]*\/>/, (el) => {
				const cx = Number(/cx="(\d+)"/.exec(el)?.[1])
				const cy = Number(/cy="(\d+)"/.exec(el)?.[1])
				if (Math.abs(cx - 12192000) <= 60000 && Math.abs(cy - 6858000) <= 60000) {
					return '<p:sldSz cx="12192000" cy="6858000"/>'
				}
				return el.replace(/\s+type="[^"]+"/, "")
			})
			zip.file("ppt/presentation.xml", pres)
		}

		// 3. bgPr: PowerPoint always writes an (empty) effectLst; Keynote wants it
		for (const name of Object.keys(zip.files)) {
			if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue
			const file = zip.file(name)
			if (!file) continue
			let xml = await file.async("string")
			if (xml.includes("<p:bgPr>") && !xml.includes("<a:effectLst/>")) {
				xml = xml.replace(/<p:bgPr>/g, "<p:bgPr><a:effectLst/>")
				zip.file(name, xml)
			}
		}

		// 4. chart fixes: dangling axis references, chartSpace boilerplate, and
		// the embedded workbook's malformed table part.
		// pptxgenjs writes a third <c:axId> for bar charts that points at an axis
		// it never defines (bar charts take exactly two) — strict importers like
		// Keynote reject the whole chart part for the dangling reference.
		for (const name of Object.keys(zip.files)) {
			if (!/^ppt\/charts\/chart\d+\.xml$/.test(name)) continue
			const file = zip.file(name)
			if (!file) continue
			let chart = await file.async("string")
			const definedAxes = new Set(
				[...chart.matchAll(/<c:(?:catAx|valAx|serAx|dateAx)>\s*<c:axId val="(\d+)"\/>/g)].map((m) => m[1]),
			)
			if (definedAxes.size > 0) {
				chart = chart.replace(/<c:axId val="(\d+)"\/>/g, (el, id: string) => (definedAxes.has(id) ? el : ""))
			}
			// c:lang is optional boilerplate, but it MUST sit after c:date1904 in
			// the chartSpace sequence (date1904?, lang?, roundedCorners?, ...).
			if (!chart.includes("<c:lang")) {
				chart = /<c:date1904[^>]*\/>/.test(chart)
					? chart.replace(/(<c:date1904[^>]*\/>)/, '$1<c:lang val="en-US"/>')
					: chart.replace(/(<c:chartSpace[^>]*>)/, '$1<c:lang val="en-US"/>')
			}
			zip.file(name, chart)
		}

		// 5. embedded workbook repair: pptxgenjs writes the chart workbook's
		// <table> part with a stray quote inside the ref attribute (e.g.
		// ref="A1:B5'") — an invalid cell range that Keynote's chart importer
		// chokes on when it opens the workbook for the chart data. Strip any
		// stray quotes from table refs so the range is well-formed.
		for (const name of Object.keys(zip.files)) {
			if (!/^ppt\/embeddings\/[^/]+\.xlsx$/.test(name)) continue
			const file = zip.file(name)
			if (!file) continue
			const workbook = await JSZip.loadAsync(await file.async("nodebuffer"))
			let repaired = false
			for (const part of Object.keys(workbook.files)) {
				if (!/^xl\/tables\/table\d+\.xml$/.test(part)) continue
				const tableFile = workbook.file(part)
				if (!tableFile) continue
				const tableXml = await tableFile.async("string")
				const fixed = tableXml.replace(/(ref="[A-Z]+\d+:[A-Z]+\d+)'([^"]*")/g, "$1$2")
				if (fixed !== tableXml) {
					workbook.file(part, fixed)
					repaired = true
				}
			}
			if (repaired) {
				zip.file(name, await workbook.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
			}
		}

		return new Uint8Array(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }))
	}

	const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer
	return sanitizeForExport(new Uint8Array(buffer))
}
