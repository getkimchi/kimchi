/**
 * Markdown → Block[] via the marked lexer. The common front-end for every
 * writer: DOCX/PPTX/PDF creators consume this IR (Phase 2+), and rounding
 * trips in the accuracy suite compare against these blocks.
 *
 * Phase 1 ships the lexer mapping + pagebreak/chart forms so writer phases
 * never need to change the IR. A literal `\f` or a line containing only
 * `---` becomes a pagebreak block (PPTX slide split; DOCX page break).
 * A fenced ```chart block becomes a chart block with raw JSON/YAML-ish spec.
 */

import { lexer, type Token, type Tokens } from "marked"

export type Inline = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string }

export type Block =
	| { type: "heading"; level: number; inline: Inline[] }
	| { type: "paragraph"; inline: Inline[] }
	| { type: "list"; ordered: boolean; start?: number; items: Block[][] }
	| { type: "table"; header: Inline[][]; align: Array<"left" | "center" | "right" | null>; rows: Inline[][][] }
	| { type: "code"; lang?: string; code: string }
	| { type: "image"; href: string; alt: string; title?: string }
	| { type: "blockquote"; blocks: Block[] }
	| { type: "hr" }
	| { type: "pagebreak" }
	| { type: "chart"; spec: string }

export function parseMarkdownBlocks(markdown: string): Block[] {
	// A line of only form-feeds or --- (three or more dashes) is a page/slide
	// split. `---` collides with markdown HR by design: inside create_document
	// content it means "next page/slide".
	const withBreaks = markdown
		.split(/\r?\n/)
		.map((line) => (/\f/.test(line) || /^-{3,}\s*$/.test(line.trim()) ? "\n\n@@KIMCHI_PAGEBREAK@@\n\n" : line))
		.join("\n")
	return tokensToBlocks(lexer(withBreaks))
}

function tokensToBlocks(tokens: Token[]): Block[] {
	const blocks: Block[] = []
	for (const token of tokens) {
		switch (token.type) {
			case "heading": {
				const t = token as Tokens.Heading
				blocks.push({ type: "heading", level: t.depth, inline: inlineOf(t.tokens ?? []) })
				break
			}
			case "paragraph": {
				const t = token as Tokens.Paragraph
				if (t.text.trim() === "@@KIMCHI_PAGEBREAK@@") {
					blocks.push({ type: "pagebreak" })
				} else {
					blocks.push({ type: "paragraph", inline: inlineOf(t.tokens ?? []) })
				}
				break
			}
			case "list": {
				const t = token as Tokens.List
				blocks.push({
					type: "list",
					ordered: t.ordered,
					start: typeof t.start === "number" ? t.start : undefined,
					items: t.items.map((item) => tokensToBlocks(item.tokens)),
				})
				break
			}
			case "table": {
				const t = token as Tokens.Table
				blocks.push({
					type: "table",
					header: t.header.map((cell) => inlineOf(cell.tokens ?? [])),
					align: t.align,
					rows: t.rows.map((row) => row.map((cell) => inlineOf(cell.tokens ?? []))),
				})
				break
			}
			case "code": {
				const t = token as Tokens.Code
				if (t.lang === "chart") blocks.push({ type: "chart", spec: t.text })
				else blocks.push({ type: "code", lang: t.lang || undefined, code: t.text })
				break
			}
			case "blockquote": {
				const t = token as Tokens.Blockquote
				blocks.push({ type: "blockquote", blocks: tokensToBlocks(t.tokens) })
				break
			}
			case "space":
			case "text":
				// Odd tokens (e.g. raw text at top level): keep as paragraph if
				// they carry visible text.
				if ("tokens" in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
					const inline = inlineOf((token as Tokens.Paragraph).tokens ?? [])
					if (inline.some((i) => i.text.trim())) blocks.push({ type: "paragraph", inline })
				}
				break
			default:
				// html/def/escape etc.: drop silently — writers never get them.
				break
		}
	}
	// `---` lines were pre-rewritten to pagebreaks; remaining hr tokens
	// (inside other contexts) carry no writer meaning — drop them.
	return blocks.filter((b) => b.type !== "hr")
}

function inlineOf(tokens: Token[]): Inline[] {
	const out: Inline[] = []
	const walk = (toks: Token[], style: Pick<Inline, "bold" | "italic" | "code" | "href">): void => {
		for (const tok of toks) {
			switch (tok.type) {
				case "strong":
					walk((tok as Tokens.Strong).tokens, { ...style, bold: true })
					break
				case "em":
					walk((tok as Tokens.Em).tokens, { ...style, italic: true })
					break
				case "codespan":
					out.push({ text: (tok as Tokens.Codespan).text, ...style, code: true })
					break
				case "link":
					walk((tok as Tokens.Link).tokens, { ...style, href: (tok as Tokens.Link).href })
					break
				case "image": {
					const t = tok as Tokens.Image
					out.push({ text: t.text || t.href, href: t.href })
					break
				}
				case "br":
					out.push({ text: "\n", ...style })
					break
				default:
					if ("tokens" in tok && Array.isArray((tok as { tokens?: Token[] }).tokens) && tok.type !== "text") {
						walk((tok as { tokens: Token[] }).tokens, style)
					} else {
						out.push({ text: (tok as Tokens.Text).text ?? tok.raw ?? "", ...style })
					}
			}
		}
	}
	walk(tokens, {})
	// Merge adjacent runs with identical style so writers see minimal runs.
	return out.reduce<Inline[]>((acc, cur) => {
		const prev = acc[acc.length - 1]
		if (
			prev &&
			!prev.code &&
			!cur.code &&
			prev.bold === cur.bold &&
			prev.italic === cur.italic &&
			prev.href === cur.href
		) {
			prev.text += cur.text
		} else {
			acc.push({ ...cur })
		}
		return acc
	}, [])
}
