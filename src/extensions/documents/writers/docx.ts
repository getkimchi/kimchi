/**
 * Markdown → DOCX via the `docx` library, on the shared Block IR.
 *
 * Pitfalls enforced up front (docx-pitfalls.ts): regular tables only, no
 * charts, explicit image types. Construction rules honored here:
 *   - explicit page size and margins (--page-size A4|Letter)
 *   - table columnWidths in DXA summing to the content width, per-cell width
 *     set to the same split (Word metrics require both)
 *   - `ShadingType.CLEAR` for header-row shading
 *   - lists through a numbering config (bullet + decimal), never manual "• "
 *   - every ImageRun has `type` and explicit dimensions in px
 *   - page breaks live inside a paragraph (never as section children)
 *   - run text never contains a raw "\n" — split into runs with breaks
 *   - bullets and headings use the built-in style ids so a TOC works
 *
 * Output determinism: call flows through the clock seam; the packed zip is
 * rebuilt with pinned entry dates so two runs with a pinned clock produce
 * byte-identical output.
 */

import { readFileSync } from "node:fs"
import { basename, resolve } from "node:path"
import {
	AlignmentType,
	Document,
	ExternalHyperlink,
	HeadingLevel,
	ImageRun,
	LevelFormat,
	Packer,
	PageBreak,
	Paragraph,
	ShadingType,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
} from "docx"
import JSZip from "jszip"
import { type DocumentClock, RealClock } from "../clock.js"
import type { Block, Inline } from "../markdown/blocks.js"
import { DocumentError } from "../model.js"
import { enforceDocxPitfalls } from "./docx-pitfalls.js"

export const PAGE_SIZES = {
	A4: { width: 11906, height: 16838 },
	Letter: { width: 12240, height: 15840 },
} as const

export type PageSizeName = keyof typeof PAGE_SIZES

/** Default page margins in DXA (1 inch). */
const MARGIN_DXA = 1440

export interface WriteDocxOptions {
	/** Base directory for resolving relative image hrefs. */
	baseDir?: string
	pageSize?: PageSizeName
	clock?: DocumentClock
}

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
	1: HeadingLevel.HEADING_1,
	2: HeadingLevel.HEADING_2,
	3: HeadingLevel.HEADING_3,
	4: HeadingLevel.HEADING_4,
	5: HeadingLevel.HEADING_5,
	6: HeadingLevel.HEADING_6,
}

const BOLD_RUN = { font: "Courier New" }

/** Inline[] → paragraph children, splitting every run at newlines into
 *  break-separated runs (raw "\n" inside run text is dropped by Word). */
function inlineChildren(inline: Inline[]): Array<TextRun | ExternalHyperlink> {
	const out: Array<TextRun | ExternalHyperlink> = []
	for (const i of inline) {
		const pieces = i.text.split("\n")
		const runs = pieces.map(
			(text, idx) =>
				new TextRun({
					text,
					bold: i.bold,
					italics: i.italic,
					break: idx > 0 ? 1 : undefined,
					...(i.code ? BOLD_RUN : {}),
				}),
		)
		if (i.href && !i.image) {
			out.push(
				new ExternalHyperlink({
					link: i.href,
					children: runs,
				}),
			)
		} else {
			out.push(...runs)
		}
	}
	return out
}

function listBlocks(block: Extract<Block, { type: "list" }>, level: number): Paragraph[] {
	const out: Paragraph[] = []
	const reference = block.ordered ? `md-decimal-${block.start ?? 1}` : "md-bullet"
	for (const item of block.items) {
		// First paragraph block in an item carries the marker; nested content
		// follows as additional paragraphs at deeper or same level.
		let firstParagraph = true
		for (const child of item) {
			if (child.type === "list") {
				out.push(...listBlocks(child, level + 1))
				continue
			}
			if (child.type === "paragraph") {
				out.push(
					new Paragraph({
						children: inlineChildren(child.inline),
						numbering: firstParagraph
							? { reference, level, instance: block.ordered ? (block.start ?? 1) : 1 }
							: undefined,
						spacing: { after: 60 },
					}),
				)
				firstParagraph = false
			} else if (child.type === "code") {
				out.push(codeParagraph(child.code.split("\n"), { indentTwips: (level + 1) * 720 }))
			}
		}
	}
	return out
}

function codeParagraph(lines: string[], opts?: { indentTwips?: number }): Paragraph {
	return new Paragraph({
		children: lines.map(
			(text, idx) =>
				new TextRun({
					text,
					break: idx > 0 ? 1 : undefined,
					...BOLD_RUN,
				}),
		),
		...(opts?.indentTwips ? { indent: { left: opts.indentTwips } } : {}),
	})
}

function tableFor(block: Extract<Block, { type: "table" }>, contentWidthDxa: number): Table {
	const cols = block.header.length
	const colWidth = Math.floor(contentWidthDxa / cols)
	const columnWidths = Array.from({ length: cols }, () => colWidth)
	const cellWidth = { size: colWidth, type: WidthType.DXA } as const

	const cell = (inline: Inline[], header: boolean) =>
		new TableCell({
			width: cellWidth,
			shading: header ? { type: ShadingType.CLEAR, fill: "D9E2F3" } : undefined,
			children: [new Paragraph({ children: inlineChildren(inline) })],
		})

	return new Table({
		width: { size: contentWidthDxa, type: WidthType.DXA },
		columnWidths,
		rows: [
			new TableRow({ tableHeader: true, children: block.header.map((h) => cell(h, true)) }),
			...block.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) })),
		],
	})
}

function imageFor(block: Extract<Block, { type: "image" }>, baseDir: string): Paragraph {
	const path = resolve(baseDir, block.href)
	let data: Uint8Array
	try {
		data = new Uint8Array(readFileSync(path))
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot read image ${block.href}: ${(err as Error).message}`, "docx")
	}
	const ext = block.href.split("?")[0].split(".").pop()?.toLowerCase() ?? ""
	const type = (ext === "jpeg" ? "jpg" : ext) as "png" | "jpg" | "gif" | "bmp"
	return new Paragraph({
		alignment: AlignmentType.CENTER,
		children: [
			new ImageRun({
				type,
				data,
				// Sensible bounded default; the alternative is measuring every
				// image first (image-size) — kept out of v1.
				transformation: { width: 480, height: 320 },
				altText: {
					title: block.title ?? basename(block.href),
					description: block.alt || block.href,
					name: basename(block.href),
				},
			}),
		],
	})
}

/** Block[] → body children (paragraphs/tables), page size applied at section. */
function buildBody(blocks: Block[], baseDir: string, contentWidthDxa: number): Array<Paragraph | Table> {
	const out: Array<Paragraph | Table> = []
	for (const b of blocks) {
		switch (b.type) {
			case "heading":
				out.push(
					new Paragraph({
						heading: HEADING_LEVELS[b.level] ?? HeadingLevel.HEADING_6,
						children: inlineChildren(b.inline),
					}),
				)
				break
			case "paragraph":
				out.push(new Paragraph({ children: inlineChildren(b.inline) }))
				break
			case "list":
				out.push(...listBlocks(b, 0))
				break
			case "table":
				out.push(tableFor(b, contentWidthDxa))
				break
			case "code":
				out.push(codeParagraph(b.code.split("\n")))
				break
			case "image":
				out.push(imageFor(b, baseDir))
				break
			case "blockquote":
				out.push(...buildBody(b.blocks, baseDir, contentWidthDxa))
				break
			case "pagebreak":
				out.push(new Paragraph({ children: [new PageBreak()] }))
				break
			default:
				break // hr/chart are handled by the pitfall guards
		}
	}
	return out
}

export interface DocxSpec {
	blocks: Block[]
	/** Title for core properties; defaults to the first heading. */
	title?: string
}

export async function writeDocx(spec: DocxSpec, options: WriteDocxOptions = {}): Promise<Uint8Array> {
	const clock = options.clock ?? RealClock
	const pageSizeName = options.pageSize ?? "Letter"
	const page = PAGE_SIZES[pageSizeName]
	const contentWidthDxa = page.width - 2 * MARGIN_DXA
	enforceDocxPitfalls({ blocks: spec.blocks, contentWidthDxa })

	const title = spec.title ?? firstHeading(spec.blocks)
	const document = new Document({
		creator: "kimchi",
		title,
		styles: {
			default: { document: { run: { font: "Calibri", size: 22 } } },
		},
		numbering: {
			config: [
				{
					reference: "md-bullet",
					levels: Array.from({ length: 9 }, (_, level) => ({
						level,
						format: LevelFormat.BULLET,
						text: level % 3 === 1 ? "o" : level % 3 === 2 ? "\u25AA" : "\u2022",
						alignment: AlignmentType.START,
						style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
					})),
				},
				...Array.from({ length: 9 }, (_, idx) => idx + 1).map((start) => ({
					reference: `md-decimal-${start}`,
					levels: Array.from({ length: 9 }, (_, level) => ({
						level,
						format: LevelFormat.DECIMAL,
						text: `%${level + 1}.`,
						alignment: AlignmentType.START,
						start,
						style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
					})),
				})),
			],
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: page.width, height: page.height },
						margin: { top: MARGIN_DXA, right: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA },
					},
				},
				children: buildBody(spec.blocks, options.baseDir ?? ".", contentWidthDxa),
			},
		],
	})
	const packed = await Packer.toBuffer(document)
	return repackDeterministic(packed, clock.now())
}

function firstHeading(blocks: Block[]): string {
	for (const b of blocks) {
		if (b.type === "heading")
			return (
				b.inline
					.map((i) => i.text)
					.join("")
					.trim() || "Untitled"
			)
	}
	return "Untitled"
}

/**
 * The library's Packer stamps zip entries with wall-clock time, so two runs
 * differ byte-wise. Rebuild the package with every entry dated by the clock
 * seam (DEFLATE stays deterministic for identical input).
 */
async function repackDeterministic(data: Buffer | Uint8Array, date: Date): Promise<Uint8Array> {
	const src = await JSZip.loadAsync(data)
	const out = new JSZip()
	const iso = date.toISOString()
	for (const [name, entry] of Object.entries(src.files)) {
		if (entry.dir) continue
		if (name === "docProps/core.xml") {
			// The library stamps core properties at pack time; overwrite with
			// the clock seam so the pinned clock wins in core.xml too.
			const xml = (await entry.async("string")).replace(
				/<dcterms:(created|modified)\b[^>]*>[^<]*<\/dcterms:\1>/g,
				(_m, kind) => `<dcterms:${kind} xsi:type="dcterms:W3CDTF">${iso}</dcterms:${kind}>`,
			)
			out.file(name, xml, { date })
			continue
		}
		out.file(name, await entry.async("uint8array"), { date })
	}
	return out.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}
