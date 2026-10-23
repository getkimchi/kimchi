/**
 * Markdown → PDF writer for pdf.mjs create. Consumes the shared block IR
 * (markdown/blocks.ts — same input shape as the PPTX writer) and draws with
 * host fonts discovered by pdf-fonts.ts so Unicode survives: standard-14 fonts only cover
 * Latin-1, and silent mojibake is the exact failure this tool exists to
 * prevent. Text the fonts can't encode is a typed error naming a sample
 * character — never dropped, never written as tofu.
 *
 * Local images only (png/jpg), resolved by the caller (`loadImage`), never
 * fetched over the network. `type: "chart"` blocks are a typed error:
 * chart rendering stays a deck concern.
 */

import { PDFDocument, type PDFFont, type PDFPage, rgb } from "@cantoo/pdf-lib"
import pdfFontkit from "@pdf-lib/fontkit"
import type { Block, Inline } from "../markdown/blocks.js"
import { DocumentError } from "../model.js"

export interface PdfWriterFonts {
	regular: PDFFont
	bold: PDFFont
	mono: PDFFont
}

/** Raw TTF/OTF bytes; the writer embeds them into ITS document (pdf-lib fonts
 *  are document-bound — cross-document PDFFonts fail at save). */
export interface PdfWriterFontBytes {
	regular: Uint8Array
	bold: Uint8Array
	mono: Uint8Array
}

export interface PdfWriteOptions {
	pageSize?: { width: number; height: number }
	/** Synchronous image resolver (CLI reads from disk). Unsupported → typed error. */
	loadImage?: (href: string) => Uint8Array
}

export const PAGE_SIZES = {
	a4: { width: 595.28, height: 841.89 },
	letter: { width: 612, height: 792 },
} as const

const MARGIN = 56
const BODY_SIZE = 11
const LINE = 1.35
type Style = "regular" | "bold" | "mono"

function fontFor(fonts: PdfWriterFonts, style: Style): PDFFont {
	return style === "bold" ? fonts.bold : style === "mono" ? fonts.mono : fonts.regular
}

/** A wrapped line as styled runs (already measured to fit the width). */
interface Run {
	text: string
	style: Style
}

/** Tokenize inline runs into width-measurable pieces (words + spaces + newlines). */
interface Token {
	text: string
	style: Style
	isSpace: boolean
	newline: boolean
}

function tokenize(inline: Inline[]): Token[] {
	const tokens: Token[] = []
	for (const t of inline) {
		const style: Style = t.code ? "mono" : t.bold ? "bold" : "regular"
		const chunks = t.text.split(/([ \t\n]+)/)
		for (const chunk of chunks) {
			if (!chunk) continue
			if (/^\s+$/.test(chunk)) {
				if (chunk.includes("\n")) {
					tokens.push({ text: "", style, isSpace: false, newline: true })
				} else {
					tokens.push({ text: " ", style, isSpace: true, newline: false })
				}
			} else {
				tokens.push({ text: chunk, style, isSpace: false, newline: false })
			}
		}
	}
	return tokens
}

/** Wrap tokens into lines fitting `width` at `size`; pdf-lib throws on unencodable text. */
function wrap(fonts: PdfWriterFonts, tokens: Token[], size: number, width: number): Run[][] {
	const lines: Run[][] = [[]]
	let used = 0
	const pushRun = (text: string, style: Style) => {
		const line = lines[lines.length - 1]!
		const last = line[line.length - 1]
		if (last && last.style === style) last.text += text
		else line.push({ text, style })
	}
	for (const tok of tokens) {
		if (tok.newline) {
			lines.push([])
			used = 0
			continue
		}
		let text = tok.text
		if (tok.isSpace && used === 0) continue // no leading spaces on a fresh line
		const w = fontFor(fonts, tok.style).widthOfTextAtSize(text, size)
		if (used + w > width && used > 0 && !tok.isSpace) {
			lines.push([])
			used = 0
		}
		if (used + w > width && tok.isSpace) continue
		// A single word wider than the column: hard-split it by characters.
		if (w > width && !tok.isSpace) {
			while (text.length > 0) {
				let take = text.length
				while (take > 1 && fontFor(fonts, tok.style).widthOfTextAtSize(text.slice(0, take), size) > width - used) take--
				const piece = text.slice(0, take)
				if (piece.length === 0) break
				pushRun(piece, tok.style)
				used += fontFor(fonts, tok.style).widthOfTextAtSize(piece, size)
				text = text.slice(take)
				if (text.length > 0) {
					lines.push([])
					used = 0
				}
			}
			continue
		}
		pushRun(text, tok.style)
		used += w
	}
	return lines
}

/** Typed failure for text the fonts can't encode — checks font coverage
 *  directly (pdf-lib would silently render .notdef for missing codepoints). */
interface Coverage {
	regular: { hasGlyph(cp: number): boolean }
	bold: { hasGlyph(cp: number): boolean }
}

function loadCoverage(fonts: KitFonts): Coverage {
	const wrap = (font: KitFont) => ({ hasGlyph: (cp: number) => font.hasGlyphForCodePoint(cp) })
	return { regular: wrap(fonts.regular.kit), bold: wrap(fonts.bold.kit) }
}

interface KitFont {
	hasGlyphForCodePoint(cp: number): boolean
}

interface KitFonts {
	regular: { bytes: Uint8Array; kit: KitFont }
	bold: { bytes: Uint8Array; kit: KitFont }
	mono: { bytes: Uint8Array; kit: KitFont }
}

function loadKitFonts(fontBytes: PdfWriterFontBytes): KitFonts {
	const wrap = (bytes: Uint8Array) => ({ bytes, kit: pdfFontkit.create(bytes) as unknown as KitFont })
	return { regular: wrap(fontBytes.regular), bold: wrap(fontBytes.bold), mono: wrap(fontBytes.mono) }
}

function collectText(blocks: Block[], out: Array<{ text: string; bold: boolean }>): void {
	for (const b of blocks) {
		switch (b.type) {
			case "heading":
				for (const i of b.inline) out.push({ text: i.text, bold: true })
				break
			case "paragraph":
				for (const i of b.inline) out.push({ text: i.text, bold: Boolean(i.bold) })
				break
			case "list":
				out.push({ text: "\u2022", bold: false })
				for (const item of b.items) collectText(item, out)
				break
			case "blockquote":
				collectText(b.blocks, out)
				break
			case "table": {
				const cells = [...b.header, ...b.rows.flat()]
				for (const cell of cells) for (const i of cell) out.push({ text: i.text, bold: Boolean(i.bold) })
				break
			}
			case "code":
				out.push({ text: b.code, bold: false })
				break
			default:
				break
		}
	}
}

function assertEncodable(coverage: Coverage, texts: Array<{ text: string; bold: boolean }>): void {
	for (const { text, bold } of texts) {
		const font = bold ? coverage.bold : coverage.regular
		for (const ch of text) {
			const cp = ch.codePointAt(0) ?? 0
			if (cp > 0x20 && !font.hasGlyph(cp)) {
				throw new DocumentError(
					"unsupported-format",
					`can't encode "${ch}" (U+${cp.toString(16).toUpperCase()}) — the font discovery picked covers common Latin/Greek/Cyrillic faces, not necessarily CJK or most emoji. Install fuller fonts and retry, or use a .docx/.pptx build instead.`,
					"pdf",
				)
			}
		}
	}
}

/** Stateful page painter: handles page breaks, margins, and reading position. */
class Canvas {
	page: PDFPage
	x = MARGIN
	y: number
	constructor(
		private readonly doc: PDFDocument,
		private readonly size: { width: number; height: number },
	) {
		this.page = doc.addPage([size.width, size.height])
		this.y = size.height - MARGIN
	}
	get contentWidth(): number {
		return this.size.width - MARGIN * 2
	}
	/** Room needed; page-breaks when short and reports where we are. */
	need(height: number): void {
		if (this.y - height < MARGIN) this.newPage()
	}
	newPage(): void {
		this.page = this.doc.addPage([this.size.width, this.size.height])
		this.y = this.size.height - MARGIN
	}
	drawLines(fonts: PdfWriterFonts, lines: Run[][], size: number, xOffset = 0): void {
		const lineHeight = size * LINE
		for (const line of lines) {
			this.need(lineHeight)
			let x = this.x + xOffset
			for (const run of line) {
				if (run.text.length > 0) {
					this.page.drawText(run.text, { x, y: this.y - size, size, font: fontFor(fonts, run.style) })
					x += fontFor(fonts, run.style).widthOfTextAtSize(run.text, size)
				}
			}
			this.y -= lineHeight
		}
	}
	gap(amount: number): void {
		this.y -= amount
		if (this.y < MARGIN) this.newPage()
	}
}

/** Wrap an error into the typed unencodable-text failure when it's an encoding issue. */
function translateErr(err: unknown): never {
	const msg = (err as Error).message ?? String(err)
	if (/encode|codepoint|glyph/i.test(msg)) {
		throw new DocumentError(
			"unsupported-format",
			`text the discovered fonts can't encode (${msg}). The host fonts cover common faces, not necessarily CJK or emoji — install fuller fonts or produce a .docx or .pptx instead.`,
			"pdf",
		)
	}
	throw err
}

/** Render blocks to bytes. All measurement/text errors are translated. */
export async function renderBlocksToPdf(
	blocks: Block[],
	fontBytes: PdfWriterFontBytes,
	options: PdfWriteOptions = {},
): Promise<Uint8Array> {
	if (blocks.length === 0) throw new DocumentError("corrupt", "nothing to render — the content has no blocks", "pdf")
	// A paragraph consisting only of images becomes image blocks; mixed
	// text+image keeps the image token (rendered as its alt text).
	blocks = blocks.flatMap((b) => {
		if (b.type === "paragraph") {
			const significant = b.inline.filter((i) => i.image || i.text.trim().length > 0)
			if (significant.length > 0 && significant.every((i) => i.image)) {
				return significant.map((i) => ({ type: "image" as const, href: i.href ?? "", alt: i.text, title: undefined }))
			}
		}
		return [b]
	})
	if (blocks.some((b) => b.type === "chart")) {
		throw new DocumentError(
			"unsupported-format",
			"```chart blocks are not supported in PDF output — describe the chart as a table, or create a .pptx deck instead",
			"pdf",
		)
	}
	const kitFonts = loadKitFonts(fontBytes)
	const coverage = loadCoverage(kitFonts)
	const texts: Array<{ text: string; bold: boolean }> = []
	collectText(blocks, texts)
	assertEncodable(coverage, texts)

	let doc: PDFDocument
	let fonts: PdfWriterFonts
	try {
		doc = await PDFDocument.create()
		doc.registerFontkit(pdfFontkit)
		// Full embedding, no subset: pdf-lib's own `subset: true` path crashes on
		// every host font we tried (undefined 'pos'), and fontkit's own subset
		// streams omit name/cmap tables pdf-lib needs at re-embed. Mitigation is
		// upstream: discovery rejects monster faces (pdf-fonts.ts). ~0.4–2 MB per
		// created document for the fonts normally discovered.
		fonts = {
			regular: await doc.embedFont(kitFonts.regular.bytes),
			bold: await doc.embedFont(kitFonts.bold.bytes),
			mono: await doc.embedFont(kitFonts.mono.bytes),
		}
	} catch (err) {
		if (err instanceof DocumentError) throw err
		// A malformed discovered font must not escape as a raw stack trace.
		throw new DocumentError(
			"tool-missing",
			`the discovered font could not be embedded (${(err as Error).message ?? err}) — the file is likely malformed; set KIMCHI_PDF_FONT_DIR to a known-good font directory`,
			"pdf",
		)
	}
	const size = options.pageSize ?? PAGE_SIZES.a4
	const canvas = new Canvas(doc, size)
	let firstBlock = true

	const renderBlocks = async (list: Block[], indent: number): Promise<void> => {
		for (const block of list) {
			switch (block.type) {
				case "pagebreak": {
					canvas.newPage()
					break
				}
				case "heading": {
					const size = block.level <= 1 ? 22 : block.level === 2 ? 16 : 13
					if (!firstBlock) canvas.gap(size * 0.9)
					canvas.need(size * LINE)
					canvas.drawLines(fonts, wrap(fonts, tokenize(block.inline), size, canvas.contentWidth - indent), size, indent)
					canvas.gap(size * 0.3)
					break
				}
				case "paragraph": {
					canvas.need(BODY_SIZE * LINE)
					canvas.drawLines(
						fonts,
						wrap(fonts, tokenize(block.inline), BODY_SIZE, canvas.contentWidth - indent),
						BODY_SIZE,
						indent,
					)
					canvas.gap(BODY_SIZE * 0.55)
					break
				}
				case "blockquote": {
					await renderBlocks(block.blocks, indent + 14)
					canvas.gap(4)
					break
				}
				case "code": {
					const lines = wrap(fonts, tokenize([{ text: block.code, code: true }]), 9, canvas.contentWidth - indent - 8)
					canvas.need(lines.length * 9 * LINE + 12)
					for (const line of lines) {
						canvas.page.drawRectangle({
							x: MARGIN + indent,
							y: canvas.y - 9 * LINE - 3,
							width: canvas.contentWidth - indent,
							height: 9 * LINE,
							color: rgb(0.95, 0.95, 0.95),
						})
						let x = MARGIN + indent + 4
						for (const run of line) {
							canvas.page.drawText(run.text, { x, y: canvas.y - 9 - 3, size: 9, font: fonts.mono })
							x += fonts.mono.widthOfTextAtSize(run.text, 9)
						}
						canvas.y -= 9 * LINE
					}
					canvas.gap(6)
					break
				}
				case "list": {
					for (const [i, item] of block.items.entries()) {
						const marker = block.ordered ? `${(block.start ?? 1) + i}.` : "•"
						canvas.drawLines(
							fonts,
							wrap(fonts, tokenize([{ text: marker }]), BODY_SIZE, canvas.contentWidth - indent),
							BODY_SIZE,
							indent,
						)
						canvas.y += BODY_SIZE * LINE // render marker on the same line as first content line
						const markerIndent = indent + 14
						try {
							await renderBlocks(item, markerIndent)
						} finally {
							// nothing — item rendering owns its own advancement
						}
						canvas.gap(2)
					}
					canvas.gap(4)
					break
				}
				case "table": {
					const cols = Math.max(1, block.header.length)
					const colW = (canvas.contentWidth - indent) / cols
					const cellPad = 4
					const cellSize = 9
					const rows: Inline[][][] = [block.header, ...block.rows]
					for (const [r, row] of rows.entries()) {
						const styled = row.map((cell) => (r === 0 ? cell.map((c) => ({ ...c, bold: true as const })) : cell))
						const cellLines = styled.map((cell) => wrap(fonts, tokenize(cell), cellSize, colW - cellPad * 2))
						const rowH = Math.max(...cellLines.map((c) => c.length)) * cellSize * LINE + cellPad * 2 + 2
						canvas.need(rowH)
						for (let c = 0; c < cols; c++) {
							let cy = canvas.y - cellPad - cellSize
							for (const line of cellLines[c] ?? []) {
								let x = MARGIN + indent + c * colW + cellPad
								for (const run of line) {
									canvas.page.drawText(run.text, { x, y: cy, size: cellSize, font: fontFor(fonts, run.style) })
									x += fontFor(fonts, run.style).widthOfTextAtSize(run.text, cellSize)
								}
								cy -= cellSize * LINE
							}
							canvas.page.drawLine({
								start: { x: MARGIN + indent + c * colW, y: canvas.y },
								end: { x: MARGIN + indent + c * colW, y: canvas.y - rowH },
								thickness: 0.5,
								color: rgb(0.8, 0.8, 0.8),
							})
						}
						canvas.page.drawLine({
							start: { x: MARGIN + indent + cols * colW, y: canvas.y },
							end: { x: MARGIN + indent + cols * colW, y: canvas.y - rowH },
							thickness: 0.5,
							color: rgb(0.8, 0.8, 0.85),
						})
						const rule = r === 0 ? 1 : 0.5
						canvas.page.drawLine({
							start: { x: MARGIN + indent, y: canvas.y },
							end: { x: MARGIN + indent + cols * colW, y: canvas.y },
							thickness: rule,
							color: rgb(0.6, 0.6, 0.6),
						})
						canvas.y -= rowH
					}
					canvas.gap(6)
					break
				}
				case "image": {
					if (!options.loadImage) {
						throw new DocumentError("unsupported-format", "images need a loader (pdf.mjs create provides one)", "pdf")
					}
					const href = block.href
					if (/^https?:\/\//i.test(href)) {
						throw new DocumentError(
							"corrupt",
							`image is a URL (${href}) — save it locally and use a relative path`,
							"pdf",
						)
					}
					const bytes = options.loadImage(href)
					const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
					const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8
					if (!isPng && !isJpg) {
						throw new DocumentError("corrupt", `image ${href} is not a PNG or JPEG`, "pdf")
					}
					const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
					const scale = Math.min(1, (canvas.contentWidth - indent) / img.width)
					const w = img.width * scale
					const h = img.height * scale
					canvas.need(h + 4)
					canvas.page.drawImage(img, { x: MARGIN + indent, y: canvas.y - h, width: w, height: h })
					canvas.y -= h + 8
					break
				}
				case "chart":
				case "hr":
					break // handled/unreachable: charts rejected above; hr dropped by the lexer
			}
			firstBlock = false
		}
	}
	try {
		await renderBlocks(blocks, 0)
		return new Uint8Array(await doc.save({ updateFieldAppearances: false }))
	} catch (err) {
		if (err instanceof DocumentError) throw err
		translateErr(err)
	}
}
