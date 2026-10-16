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
// pptxgenjs's shipped .d.ts (`export default` a class merged with `export as
// namespace`) isn't constructable under NodeNext import resolution, so the
// default import is cast through the minimal surface this writer uses. The
// bundled output (bun build) and vitest both resolve the same static import.
import pptxgenDefault from "pptxgenjs"
import { type Block, type Inline, parseMarkdownBlocks } from "../markdown/blocks.js"
import { DocumentError } from "../model.js"
import { enforcePitfalls, slideNeedsLightText } from "./pitfalls.js"
import type { ChartSpec, DeckMeta, DeckSpec, DeckTheme, LayoutHint, SlideElement, SlideSpec } from "./pptx-model.js"

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg"])
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const LAYOUT_HINTS: LayoutHint[] = ["title", "content", "two-column", "table", "chart", "blank"]

const DEFAULT_FONT = "Calibri"
const DEFAULT_ACCENT = "00A3A1"
const DEFAULT_SLIDE_W = 13.33
const DEFAULT_SLIDE_H = 7.5
const MARGIN = 0.6

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
				slide.elements.push({ type: "heading", level: block.level, inline: block.inline })
				seenContent = true
				continue
			}
			if (block.type === "table") {
				slide.elements.push({ type: "table", header: block.header, rows: block.rows })
				seenContent = true
				continue
			}
			if (block.type === "code") {
				slide.elements.push({
					type: "paragraphs",
					inline: [[{ text: block.code, code: true }]],
				})
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
		throw new DocumentError("unsupported-format", `slide ${slide.index}: image "${path}" is not PNG/JPEG/GIF/SVG`)
	}
	if (!exists(path)) {
		throw new DocumentError("corrupt", `slide ${slide.index}: image not found: ${path}`)
	}
	if (size(path) > MAX_IMAGE_BYTES) {
		throw new DocumentError("too-large", `slide ${slide.index}: image "${path}" exceeds the 20 MB cap`)
	}
}

function flattenBullets(
	el: SlideElement & { type: "bullets" },
	color?: string,
): Array<{ text: string; options: Record<string, unknown> }> {
	const out: Array<{ text: string; options: Record<string, unknown> }> = []
	const walk = (items: typeof el.items, depth: number) => {
		for (const item of items) {
			const text = item.inline.map((i) => i.text).join("")
			out.push({
				text,
				options: {
					bullet: { indent: depth * 18 },
					breakLine: true,
					...(item.inline.some((i) => i.bold) ? { bold: true } : {}),
					...(item.inline.some((i) => i.italic) ? { italic: true } : {}),
					...(color ? { color } : {}),
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

function layoutGeometry(hint: LayoutHint | undefined, w: number, h: number) {
	const inner = w - 2 * MARGIN
	const heading = { x: MARGIN, y: 0.35, w: inner, h: 0.9 }
	switch (hint) {
		case "title":
			return {
				heading: { x: MARGIN, y: h * 0.35, w: inner, h: 1.4, align: "center" as const },
				body: { x: MARGIN, y: h * 0.6, w: inner, h: h * 0.3 },
			}
		case "two-column":
			return {
				heading,
				columns: [
					{ x: MARGIN, y: 1.5, w: inner / 2 - 0.2, h: h - 2 },
					{ x: MARGIN + inner / 2 + 0.2, y: 1.5, w: inner / 2 - 0.2, h: h - 2 },
				],
			}
		case "table":
		case "chart":
		case "blank":
		case "content":
		case undefined:
		default:
			return { heading, body: { x: MARGIN, y: 1.5, w: inner, h: h - 2.1 } }
	}
}

interface Geometry {
	heading: { x: number; y: number; w: number; h: number; align?: "center" }
	body?: { x: number; y: number; w: number; h: number }
	columns?: Array<{ x: number; y: number; w: number; h: number }>
}

export async function writePptx(spec: DeckSpec, options: WriteOptions = {}): Promise<Uint8Array> {
	enforcePitfalls(spec.slides)

	const theme = spec.theme
	const w = theme.slideWidth ?? DEFAULT_SLIDE_W
	const h = theme.slideHeight ?? DEFAULT_SLIDE_H
	const font = theme.font ?? DEFAULT_FONT
	const accent = (theme.accent ?? DEFAULT_ACCENT).replace("#", "")
	const pptx: PptxInstance = new PptxGenJS()
	pptx.defineLayout({ name: "KIMCHI", width: w, height: h })
	pptx.layout = "KIMCHI"
	if (spec.meta.title) pptx.title = spec.meta.title
	if (spec.meta.author) pptx.author = spec.meta.author
	pptx.theme = { headFontFace: font, bodyFontFace: font }

	for (const slide of spec.slides) {
		const geo = layoutGeometry(slide.layoutHint, w, h) as Geometry
		const s = pptx.addSlide()
		if (slide.background) {
			s.background = { color: slide.background.replace("#", "") }
		}
		const color = slideNeedsLightText(slide.background) ? "FFFFFF" : undefined
		if (slide.heading !== undefined) {
			const isTitle = slide.layoutHint === "title"
			s.addText(slide.heading, {
				...geo.heading,
				fontFace: font,
				fontSize: isTitle ? 44 : 28,
				bold: true,
				color: color ?? accent,
				align: geo.heading.align,
			})
		}

		// Two-column: body blocks split across two boxes (see two-column-needs-hint).
		if (slide.layoutHint === "two-column") {
			const bodies = slide.elements.filter((e) => e.type === "bullets" || e.type === "paragraphs")
			bodies.forEach((el, colIdx) => {
				const box = geo.columns?.[Math.min(colIdx, (geo.columns?.length ?? 1) - 1)]
				if (!box) return
				if (el.type === "bullets") {
					s.addText(flattenBullets(el, color), { ...box, fontFace: font, fontSize: 16 })
				} else {
					const runs = el.inline.flatMap((p) => [
						...pptxRunFromInline(p, color),
						{ text: "\n", options: { breakLine: true } },
					])
					s.addText(runs, { ...box, fontFace: font, fontSize: 16 })
				}
			})
		}

		for (const el of slide.elements) {
			if (slide.layoutHint === "two-column" && (el.type === "bullets" || el.type === "paragraphs")) continue
			const box = geo.body ?? { x: MARGIN, y: 1.5, w: w - 2 * MARGIN, h: h - 2.1 }
			switch (el.type) {
				case "heading":
					s.addText(inlineText(el.inline), {
						x: box.x,
						y: box.y,
						w: box.w,
						h: 0.5,
						fontFace: font,
						fontSize: 20,
						bold: true,
						color,
					})
					break
				case "paragraphs": {
					const runs = el.inline.flatMap((p) => [
						...pptxRunFromInline(p, color),
						{ text: "\n", options: { breakLine: true } },
					])
					s.addText(runs, { ...box, fontFace: font, fontSize: 16 })
					break
				}
				case "bullets":
					s.addText(flattenBullets(el, color), { ...box, fontFace: font, fontSize: 16 })
					break
				case "table": {
					s.addTable(
						[
							el.header.map((cell) => ({
								text: inlineText(cell),
								options: { bold: true, fill: { color: accent }, color: "FFFFFF" },
							})),
							...el.rows.map((row) => row.map((cell) => inlineText(cell))),
						],
						{ ...box, fontFace: font, fontSize: 14, border: { pt: 1, color: accent } },
					)
					break
				}
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
						{ ...box, chartTitle: el.spec.title, chartColors: [accent, "7FDBD4", "1F6F8B", "F4B860"] },
					)
					break
				}
				case "image": {
					const path = isAbsolute(el.path) ? el.path : normalize(`${options.baseDir ?? "."}/${el.path}`)
					checkImage(path, slide, options)
					s.addImage({ path, ...box, alt: el.alt })
					break
				}
			}
		}

		if (slide.notes.length > 0) s.addNotes(slide.notes.join("\n"))
	}

	const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer
	return new Uint8Array(buffer)
}
